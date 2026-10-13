// Package browserbay is the Go client for browserbay, a self-hosted service that lends out Chromium browsers.
//
// A client asks the box (the browserbay service) for a slot, which is one isolated browser. The box answers with a
// DevTools WebSocket address and a token. Hand both to Playwright, Puppeteer, chromedp or any CDP library:
//
//	box, err := browserbay.New(browserbay.Options{URL: "https://browsers.example.com", APIKey: key})
//	if err != nil { ... }
//	slot, err := box.Acquire(ctx, browserbay.AcquireOptions{RunID: "task-42", MaxLifetime: 30 * time.Minute})
//	if err != nil { ... }
//	defer slot.Release(ctx)
//	// connect to slot.CDPURL with the headers from slot.Headers()
//
// The package uses only the standard library. Its behaviour follows the reference Node client that ships with
// browserbay: the same run id, lifetime and wait limits, the same namespace handling, and the same refusal to send
// credentials to a box the client was not made for.
//
// A [Client] is safe for concurrent use.
package browserbay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
	"unicode/utf16"
)

// TokenHeader is the header every DevTools connection to a slot, and every lookup of a slot by its own token, must carry.
const TokenHeader = "x-browserbay-token"

// Limits the box enforces on a slot request. The client checks them up front so a bad call fails without a round trip.
const (
	// MinLifetime is the shortest maximum lifetime the box accepts.
	MinLifetime = 60 * time.Second
	// MaxLifetime is the longest maximum lifetime the box accepts.
	MaxLifetime = 86400 * time.Second
	// MaxRunIDLength is the longest run id the box accepts, in characters. A namespace prefix counts.
	MaxRunIDLength = 200
)

// Defaults for the options below.
const (
	// DefaultWait is how long [Client.Acquire] waits for a free slot when [AcquireOptions.Wait] is zero.
	DefaultWait = 30 * time.Second
	// DefaultGrace is how long [Client.Reap] leaves a young slot alone when [ReapOptions.Grace] is zero.
	DefaultGrace = 3 * time.Minute
	// DefaultRetryDelay is the pause between the two asks of [Slot.IsAlive] when [Options.RetryDelay] is zero.
	DefaultRetryDelay = 300 * time.Millisecond
)

const (
	// NoWait, as [AcquireOptions.Wait], means do not wait for a free slot: answer at once with [ErrNoCapacity] if there is none.
	NoWait time.Duration = -1
	// NoGrace, as [ReapOptions.Grace], means no slot is too young to reap.
	NoGrace time.Duration = -1
	// NoRetryDelay, as [Options.RetryDelay], means [Slot.IsAlive] asks its second time without pausing.
	NoRetryDelay time.Duration = -1
)

// Timeouts per kind of request. The acquire margin is longer than the box's own wait, so a full box is answered with
// 503 and not cut off by this side's timer.
const (
	acquireTimeoutMargin = 20 * time.Second
	lookupTimeout        = 3 * time.Second
	releaseTimeout       = 10 * time.Second
	requestTimeout       = 15 * time.Second
	maxResponseBytes     = 8 << 20
)

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// Logger receives the client's warnings: problems it works around, such as a slot [Client.Reap] could not release.
// Fields never contain the API key or a slot token.
type Logger interface {
	Warn(message string, fields map[string]any)
}

// LoggerFunc adapts a function to the [Logger] interface.
type LoggerFunc func(message string, fields map[string]any)

// Warn calls f.
func (f LoggerFunc) Warn(message string, fields map[string]any) { f(message, fields) }

// Options configures a [Client]. URL and APIKey are required.
type Options struct {
	// URL is the box's base URL, such as https://browsers.example.com. A path prefix is kept.
	URL string
	// APIKey is the box's API key: it lets this service create, list and release browsers. It never reaches a browser.
	APIKey string
	// Namespace marks this service's slots (as a prefix on their run ids) so [Client.List] and [Client.Reap] leave
	// another service's alone when several share a box. Letters, digits, "_", "." and "-" only. A naming convention,
	// not an access control: anything holding the API key can still reach any slot.
	Namespace string
	// AllowOtherBoxes lists the boxes, other than this client's, that a stored slot ([Client.Slot]) or a release
	// ([Client.ReleaseAt]) may name. None by default: the API key and slot tokens are sent to the box a slot names, so
	// an address read back from storage that someone else could have written would be somewhere to send them. List
	// the boxes your slots may have been made on (the address your service used before it moved, say). Addresses are
	// compared however they are spelled.
	AllowOtherBoxes []string
	// AllowAnyBox allows any address in a stored slot. It is only safe for storage nobody else can write.
	AllowAnyBox bool
	// HTTPClient makes every request. The default is a client that follows redirects within one host only, so
	// credentials are not forwarded elsewhere. Requests are bounded by their context and their own timeouts, so the
	// client needs none of its own.
	HTTPClient *http.Client
	// Logger receives warnings. Nil discards them.
	Logger Logger
	// Now is the clock [Client.Reap] uses to age slots. Default time.Now.
	Now func() time.Time
	// RetryDelay is the pause between [Slot.IsAlive]'s two asks. Zero means [DefaultRetryDelay]; [NoRetryDelay] means none.
	RetryDelay time.Duration
}

// AcquireOptions describes the browser to take.
type AcquireOptions struct {
	// RunID is your own id for what the browser is for (a run, a task, a job), 1 to 200 characters with the
	// namespace prefix counted. [Client.List] and [Client.Reap] hand it back to you.
	RunID string
	// MaxLifetime is how long the browser's node keeps it open, whether or not anyone is still connected. A whole
	// number of seconds, from [MinLifetime] to [MaxLifetime].
	MaxLifetime time.Duration
	// Wait is how long to wait for a free slot before giving up with [ErrNoCapacity], in whole milliseconds. The
	// box caps it at its own maximum. Zero means [DefaultWait]; [NoWait] means do not wait.
	Wait time.Duration
}

// ReapOptions configures [Client.Reap].
type ReapOptions struct {
	// IsLive says whether the thing a slot was acquired for (its run id, without the namespace) still needs its
	// browser. If it returns an error the slot is left alone: not knowing is not a reason to release someone's browser.
	IsLive func(ctx context.Context, runID string) (bool, error)
	// Grace is how young a slot may be and still be left alone, because it may be between "created" and "saved on
	// its run". Zero means [DefaultGrace]; [NoGrace] means no slot is too young.
	Grace time.Duration
	// Skip, if set, names run ids that nothing can vouch for (and that close themselves at their lifetime), which are left alone.
	Skip func(runID string) bool
}

// SlotSummary describes a slot on the box, without its token.
type SlotSummary struct {
	SlotID string `json:"slotId"`
	// RunID is the run id the slot was acquired with, with this client's namespace (if any) removed.
	RunID  string `json:"runId"`
	NodeID string `json:"nodeId"`
	// CreatedAt is zero when the box sent a time that could not be read.
	CreatedAt time.Time `json:"createdAt"`
}

// NodeSummary describes a node (a machine that runs browsers) and its load.
type NodeSummary struct {
	NodeID      string    `json:"nodeId"`
	MaxContexts int       `json:"maxContexts"`
	Contexts    int       `json:"contexts"`
	Draining    bool      `json:"draining"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
}

// Client talks to one box. Make it with [New].
type Client struct {
	boxURL     string
	ownBox     string
	apiKey     string
	prefix     string
	otherBoxes map[string]struct{}
	allowAny   bool
	http       *http.Client
	logger     Logger
	now        func() time.Time
	retryDelay time.Duration
}

// New checks its options and makes a client. It sends nothing to the box.
//
// It fails with [ErrInvalidArgument] for an address that is not http(s)://, a missing API key, or a namespace with
// characters outside letters, digits, "_", "." and "-" (a ":" would let namespace "app" see the slots of "app:staging").
func New(opts Options) (*Client, error) {
	boxURL, err := parseBoxURL(opts.URL)
	if err != nil {
		return nil, err
	}
	if opts.APIKey == "" {
		return nil, invalid("New needs an APIKey")
	}
	if opts.Namespace != "" && !namePattern.MatchString(opts.Namespace) {
		return nil, invalid(`a namespace may only contain letters, digits, "_", "." and "-"`)
	}
	c := &Client{
		boxURL:     boxURL,
		ownBox:     canonicalBox(boxURL),
		apiKey:     opts.APIKey,
		otherBoxes: make(map[string]struct{}),
		allowAny:   opts.AllowAnyBox,
		http:       opts.HTTPClient,
		logger:     opts.Logger,
		now:        opts.Now,
		retryDelay: opts.RetryDelay,
	}
	if opts.Namespace != "" {
		c.prefix = opts.Namespace + ":"
	}
	// Other boxes a stored slot may name (a box that moved while slots were live): listed, so each is checked up front.
	for _, other := range opts.AllowOtherBoxes {
		trimmed, err := parseBoxURL(other)
		if err != nil {
			return nil, err
		}
		c.otherBoxes[canonicalBox(trimmed)] = struct{}{}
	}
	if c.http == nil {
		c.http = defaultHTTPClient()
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.retryDelay == 0 {
		c.retryDelay = DefaultRetryDelay
	}
	return c, nil
}

// defaultHTTPClient follows redirects only within one host and never from https to http: Go would drop the
// Authorization header on a hop to another host but would still forward a slot token, and on a hop within the host
// it forwards both headers whatever the scheme.
func defaultHTTPClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			if req.URL.Host != via[0].URL.Host {
				return errors.New("refusing to follow a redirect to another host")
			}
			if via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
				return errors.New("refusing to follow a redirect from https to plain http")
			}
			return nil
		},
	}
}

// boxOf returns the box a slot lives on. The API key (to release) and the slot token (to look it up) are sent there, so
// an address read back from storage is only used when it is this client's own box or one the options list.
func (c *Client) boxOf(rawURL string) (string, error) {
	if rawURL == "" {
		return c.boxURL, nil
	}
	base, err := parseBoxURL(rawURL)
	if err != nil {
		return "", err
	}
	known := canonicalBox(base)
	if known != c.ownBox && !c.allowAny {
		if _, ok := c.otherBoxes[known]; !ok {
			return "", fmt.Errorf(
				"browserbay: %w: this slot is on %s, not on this client's box (%s). "+
					"Its credentials are only sent to the box this client was made for or one listed in AllowOtherBoxes",
				ErrUntrustedBox, originOf(base), originOf(c.boxURL))
		}
	}
	return base, nil
}

// roundTrip sends one request bounded by timeout and returns the status and the (size-limited) body.
func (c *Client) roundTrip(ctx context.Context, method, target string, header http.Header, body []byte, timeout time.Duration) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, nil, err
	}
	for name, values := range header {
		req.Header[name] = values
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

// api is a call to the box as its owner (create, list, release). The address is a parameter: a stored slot names its own.
func (c *Client) api(ctx context.Context, base, method, path string, body []byte, timeout time.Duration) (int, []byte, error) {
	header := http.Header{"Authorization": {"Bearer " + c.apiKey}}
	if body != nil {
		header.Set("Content-Type", "application/json")
	}
	return c.roundTrip(ctx, method, base+path, header, body, timeout)
}

func slotPath(slotID string) string { return "/v1/slots/" + url.PathEscape(slotID) }

// errorFrom builds an *Error for a status the client did not expect, keeping the box's own error code if it sent one.
func errorFrom(status int, data []byte, format string, args ...any) *Error {
	e := newError(status, "", format, args...)
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && errorCodePattern.MatchString(body.Error) {
		e.Code = body.Error
	}
	return e
}

func (c *Client) deleteSlot(ctx context.Context, base, slotID string) error {
	status, data, err := c.api(ctx, base, http.MethodDelete, slotPath(slotID), nil, releaseTimeout)
	if err != nil {
		return fmt.Errorf("browserbay: could not release a browser: %w", err)
	}
	// A slot that is already gone is the goal, not a problem.
	if (status < 200 || status > 299) && status != http.StatusNotFound {
		return errorFrom(status, data, "the browser service could not release a browser (%d)", status)
	}
	return nil
}

// lookup asks the box about a slot with the slot's own token. The box answers 200 only while the slot's browser is reachable.
func (c *Client) lookup(ctx context.Context, base, slotID, token string) bool {
	for attempt := 0; attempt < 2; attempt++ {
		header := http.Header{}
		header.Set(TokenHeader, token)
		status, _, err := c.roundTrip(ctx, http.MethodGet, base+slotPath(slotID), header, nil, lookupTimeout)
		if err == nil {
			if status >= 200 && status <= 299 {
				return true
			}
			// 404 or 401: the slot is gone, or the address now belongs to another. Only a server error is worth another try.
			if status < 500 {
				return false
			}
		}
		// A restart of the box or a dropped request is not proof the slot is gone, so try once more, unless the
		// caller has given up.
		if ctx.Err() != nil {
			return false
		}
		if attempt == 0 && c.retryDelay > 0 {
			timer := time.NewTimer(c.retryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return false
			case <-timer.C:
			}
		}
	}
	return false
}

func (c *Client) makeSlot(stored StoredSlot) (*Slot, error) {
	base, err := c.boxOf(stored.URL)
	if err != nil {
		return nil, err
	}
	return &Slot{
		URL:    base,
		SlotID: stored.SlotID,
		NodeID: stored.NodeID,
		Token:  stored.Token,
		CDPURL: cdpURLFor(base, stored.SlotID),
		client: c,
	}, nil
}

// Acquire takes a browser. It fails with [ErrNoCapacity] when the box stays full for the whole wait, with
// [ErrQuotaExceeded] when the API key's quota is used up, with [ErrForbidden] when the key may not use this run id, with
// [ErrInvalidArgument] (before sending anything) when an option is one the box would refuse, and with an *[Error]
// for any other answer it cannot use.
func (c *Client) Acquire(ctx context.Context, opts AcquireOptions) (*Slot, error) {
	fullRunID := c.prefix + opts.RunID
	if opts.RunID == "" || len(utf16.Encode([]rune(fullRunID))) > MaxRunIDLength {
		return nil, invalid("RunID must be a string of 1 to %d characters (the namespace counts)", MaxRunIDLength)
	}
	if opts.MaxLifetime < MinLifetime || opts.MaxLifetime > MaxLifetime || opts.MaxLifetime%time.Second != 0 {
		return nil, invalid("MaxLifetime must be a whole number of seconds from %d to %d",
			int(MinLifetime/time.Second), int(MaxLifetime/time.Second))
	}
	wait := opts.Wait
	switch {
	case wait == 0:
		wait = DefaultWait
	case wait < 0:
		wait = 0
	case wait%time.Millisecond != 0:
		return nil, invalid("Wait must be a whole number of milliseconds")
	}
	body, err := json.Marshal(struct {
		RunID              string `json:"runId"`
		MaxLifetimeSeconds int64  `json:"maxLifetimeSeconds"`
		WaitMilliseconds   int64  `json:"waitMs"`
	}{fullRunID, int64(opts.MaxLifetime / time.Second), int64(wait / time.Millisecond)})
	if err != nil {
		return nil, err
	}
	status, data, err := c.api(ctx, c.boxURL, http.MethodPost, "/v1/slots", body, wait+acquireTimeoutMargin)
	if err != nil {
		return nil, fmt.Errorf("browserbay: could not start a browser: %w", err)
	}
	// The box held the request for the whole wait and still found no node with room (or lost the node it chose).
	if status == http.StatusServiceUnavailable {
		return nil, noCapacity()
	}
	// A key confined to another namespace, or out of quota: told apart from a box that is merely full.
	if status == http.StatusForbidden {
		return nil, forbidden()
	}
	if status == http.StatusTooManyRequests {
		return nil, quotaExceeded()
	}
	if status < 200 || status > 299 {
		return nil, errorFrom(status, data, "the browser service could not start a browser (%d)", status)
	}
	var created struct {
		SlotID string `json:"slotId"`
		Token  string `json:"token"`
		NodeID string `json:"nodeId"`
	}
	_ = json.Unmarshal(data, &created)
	if created.SlotID == "" || created.Token == "" || created.NodeID == "" {
		return nil, newError(status, "", "the browser service returned an incomplete slot")
	}
	return c.makeSlot(StoredSlot{URL: c.boxURL, SlotID: created.SlotID, Token: created.Token, NodeID: created.NodeID})
}

// Slot rebuilds a slot from what [Slot.Stored] (or json.Marshal of a slot) gave you earlier. It makes no request:
// use [Slot.IsAlive] to find out whether the slot still exists.
//
// A stored slot names the box it lives on. It is refused with [ErrUntrustedBox] unless that is this client's box or
// one listed in [Options.AllowOtherBoxes], so a tampered row cannot redirect the API key or the slot token.
func (c *Client) Slot(stored StoredSlot) (*Slot, error) {
	if stored.SlotID == "" || stored.Token == "" {
		return nil, invalid("a stored slot needs a SlotID and a Token")
	}
	return c.makeSlot(stored)
}

// Release closes a browser by its id, for when you no longer hold its token (a stored handle you cannot decrypt, an
// orphan found by [Client.List]). Idempotent: a slot that is already gone is not an error.
func (c *Client) Release(ctx context.Context, slotID string) error {
	return c.ReleaseAt(ctx, "", slotID)
}

// ReleaseAt is [Client.Release] for a slot on another box, such as one a stored slot named. An empty boxURL means this
// client's box. Any other address must be one the options allow, or it fails with [ErrUntrustedBox] without sending anything.
func (c *Client) ReleaseAt(ctx context.Context, boxURL, slotID string) error {
	if slotID == "" {
		return invalid("Release needs a slotID")
	}
	base, err := c.boxOf(boxURL)
	if err != nil {
		return err
	}
	return c.deleteSlot(ctx, base, slotID)
}

// List returns this service's slots: all of them, or with a namespace only that namespace's, with the namespace
// removed from their run ids. The listing carries no tokens.
func (c *Client) List(ctx context.Context) ([]SlotSummary, error) {
	status, data, err := c.api(ctx, c.boxURL, http.MethodGet, "/v1/slots", nil, requestTimeout)
	if err != nil {
		return nil, fmt.Errorf("browserbay: could not list browsers: %w", err)
	}
	if status < 200 || status > 299 {
		return nil, errorFrom(status, data, "the browser service could not list browsers (%d)", status)
	}
	var body struct {
		Slots []json.RawMessage `json:"slots"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, newError(status, "", "the browser service sent a listing that is not JSON")
	}
	mine := make([]SlotSummary, 0, len(body.Slots))
	for _, raw := range body.Slots {
		var wire struct {
			SlotID    string  `json:"slotId"`
			RunID     *string `json:"runId"`
			NodeID    string  `json:"nodeId"`
			CreatedAt string  `json:"createdAt"`
		}
		if json.Unmarshal(raw, &wire) != nil || wire.SlotID == "" || wire.RunID == nil {
			continue
		}
		runID := *wire.RunID
		if c.prefix != "" {
			// Another service's slots on a shared box carry its prefix, or none: not ours to see.
			if len(runID) < len(c.prefix) || runID[:len(c.prefix)] != c.prefix {
				continue
			}
			runID = runID[len(c.prefix):]
		}
		mine = append(mine, SlotSummary{SlotID: wire.SlotID, RunID: runID, NodeID: wire.NodeID, CreatedAt: parseTime(wire.CreatedAt)})
	}
	return mine, nil
}

// Nodes lists the machines that run the box's browsers, with their capacity and load.
func (c *Client) Nodes(ctx context.Context) ([]NodeSummary, error) {
	status, data, err := c.api(ctx, c.boxURL, http.MethodGet, "/v1/nodes", nil, requestTimeout)
	if err != nil {
		return nil, fmt.Errorf("browserbay: could not list nodes: %w", err)
	}
	if status < 200 || status > 299 {
		return nil, errorFrom(status, data, "the browser service could not list nodes (%d)", status)
	}
	var body struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, newError(status, "", "the browser service sent a node list that is not JSON")
	}
	nodes := make([]NodeSummary, 0, len(body.Nodes))
	for _, raw := range body.Nodes {
		var wire struct {
			NodeID      string `json:"nodeId"`
			MaxContexts int    `json:"maxContexts"`
			Contexts    int    `json:"contexts"`
			Draining    bool   `json:"draining"`
			LastSeenAt  string `json:"lastSeenAt"`
		}
		if json.Unmarshal(raw, &wire) != nil || wire.NodeID == "" {
			continue
		}
		nodes = append(nodes, NodeSummary{
			NodeID: wire.NodeID, MaxContexts: wire.MaxContexts, Contexts: wire.Contexts,
			Draining: wire.Draining, LastSeenAt: parseTime(wire.LastSeenAt),
		})
	}
	return nodes, nil
}

// Reap releases slots whose run IsLive says no to, for when a crash lost track of them, and returns how many it
// released. It only looks at this client's namespace. A failed listing stops it with an error; a slot whose
// IsLive check or release fails is logged and left for the next pass, and the others are still handled. If ctx ends
// it stops and returns the count so far with the context's error.
func (c *Client) Reap(ctx context.Context, opts ReapOptions) (int, error) {
	if opts.IsLive == nil {
		return 0, invalid("Reap needs an IsLive function")
	}
	grace := opts.Grace
	switch {
	case grace == 0:
		grace = DefaultGrace
	case grace < 0:
		grace = 0
	}
	slots, err := c.List(ctx)
	if err != nil {
		return 0, err
	}
	released := 0
	for _, slot := range slots {
		if err := ctx.Err(); err != nil {
			return released, err
		}
		// A slot younger than the grace period may be between "created" and "saved on its run".
		if !slot.CreatedAt.IsZero() && c.now().Sub(slot.CreatedAt) < grace {
			continue
		}
		if opts.Skip != nil && opts.Skip(slot.RunID) {
			continue
		}
		if slot.RunID != "" {
			live, err := opts.IsLive(ctx, slot.RunID)
			if err != nil {
				// Not knowing is not a reason to release someone's browser, or to stop checking the others.
				c.warn("Could not tell whether a browser is still needed", slot.SlotID, err)
				continue
			}
			if live {
				continue
			}
		}
		if err := c.deleteSlot(ctx, c.boxURL, slot.SlotID); err != nil {
			c.warn("Could not release an orphaned browser", slot.SlotID, err)
			continue
		}
		released++
	}
	return released, nil
}

func (c *Client) warn(message, slotID string, err error) {
	if c.logger != nil {
		c.logger.Warn(message, map[string]any{"slotId": slotID, "error": err.Error()})
	}
}

func parseTime(value string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

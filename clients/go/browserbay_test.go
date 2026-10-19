package browserbay_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	browserbay "github.com/degoke/browserbay/clients/go"
)

const (
	apiKey = "box-api-key-0123456789"
	box    = "https://browsers.example.com"
)

var testNow = time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)

// ---- a stand-in for the relay's REST surface ----------------------------------------------------------------------

type call struct {
	Method string
	URL    string // as sent, e.g. https://browsers.example.com/v1/slots
	Path   string
	Header http.Header
	Body   map[string]any
}

type boxSlot struct {
	slotID, runID, nodeID, token string
	createdAt                    time.Time
}

type fakeOptions struct {
	// prefix is a path prefix the box is served under (a reverse proxy).
	prefix       string
	createStatus int
	createBody   string
	// modern makes the box answer like one that knows the slot options: "applied" names the ones in the request. Off, it
	// is a box that predates them and says nothing.
	modern       bool
	deleteStatus func(slotID string) int
	listStatus   int
	// slotLookups scripts the next lookups before the table answers: "network" or an HTTP status.
	slotLookups []any
	now         func() time.Time
}

// fakeBox is a slot table behind the same auth rules as the relay: the API key for create, list, nodes and release;
// the slot's own token for looking it up. It is an http.Handler and an http.RoundTripper, so a test can reach it over
// a real socket or through a client that never leaves the process.
type fakeBox struct {
	opts fakeOptions

	mu      sync.Mutex
	calls   []call
	slots   map[string]*boxSlot
	order   []string
	lookups []any
	counter int
	// nodesBody, when set, is what GET /v1/nodes answers.
	nodesBody string
}

func newFakeBox(opts fakeOptions) *fakeBox {
	return &fakeBox{opts: opts, slots: map[string]*boxSlot{}, lookups: append([]any(nil), opts.slotLookups...)}
}

// seed adds a slot that already exists on the box, as the reaper sees it.
func (f *fakeBox) seed(slotID, runID string, ageMinutes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.slots[slotID] = &boxSlot{
		slotID: slotID, runID: runID, nodeID: "node-1", token: "token-of-" + slotID,
		createdAt: testNow.Add(-time.Duration(ageMinutes) * time.Minute),
	}
	f.order = append(f.order, slotID)
}

func (f *fakeBox) slotIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := make([]string, 0, len(f.slots))
	for id := range f.slots {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (f *fakeBox) token(slotID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.slots[slotID].token
}

func (f *fakeBox) setToken(slotID, token string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.slots[slotID].token = token
}

func (f *fakeBox) clear() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.slots = map[string]*boxSlot{}
	f.order = nil
}

func (f *fakeBox) callLog() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]call(nil), f.calls...)
}

var slotPathPattern = regexp.MustCompile(`^/v1/slots/([^/]+)$`)

func (f *fakeBox) lookupCalls() []call {
	var out []call
	for _, c := range f.callLog() {
		if c.Method == http.MethodGet && slotPathPattern.MatchString(c.Path) {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeBox) deleted() []string {
	var out []string
	for _, c := range f.callLog() {
		if c.Method == http.MethodDelete {
			out = append(out, c.Path[strings.LastIndex(c.Path, "/")+1:])
		}
	}
	return out
}

func reply(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if status != http.StatusNoContent {
		if body == "" {
			body = "{}"
		}
		_, _ = io.WriteString(w, body)
	}
}

func asJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func (f *fakeBox) summary(s *boxSlot) map[string]any {
	return map[string]any{
		"slotId": s.slotID, "runId": s.runID, "nodeId": s.nodeID, "createdAt": s.createdAt.Format("2006-01-02T15:04:05.000Z"),
	}
}

func (f *fakeBox) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if r.Body != nil {
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
	}
	f.mu.Lock()
	scheme := "http"
	if r.TLS != nil || r.URL.Scheme == "https" {
		scheme = "https"
	}
	host := r.Host
	if r.URL.Host != "" {
		host = r.URL.Host
	}
	f.calls = append(f.calls, call{
		Method: r.Method, URL: scheme + "://" + host + r.URL.Path, Path: r.URL.Path, Header: r.Header.Clone(), Body: body,
	})
	defer f.mu.Unlock()

	if !strings.HasPrefix(r.URL.Path, f.opts.prefix) {
		reply(w, 404, `{"error":"not_found"}`)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, f.opts.prefix)
	asOwner := r.Header.Get("Authorization") == "Bearer "+apiKey
	now := time.Now
	if f.opts.now != nil {
		now = f.opts.now
	}

	switch {
	case path == "/v1/slots" && r.Method == http.MethodPost:
		if !asOwner {
			reply(w, 401, `{"error":"unauthorized"}`)
			return
		}
		if f.opts.createStatus != 0 && f.opts.createStatus != 201 {
			reply(w, f.opts.createStatus, f.opts.createBody)
			return
		}
		if f.opts.createBody != "" {
			reply(w, 201, f.opts.createBody)
			return
		}
		f.counter++
		id := fmt.Sprintf("slot-%d", f.counter)
		slot := &boxSlot{
			slotID: id, runID: fmt.Sprint(body["runId"]), nodeID: "node-1",
			createdAt: now(), token: fmt.Sprintf("slot-token-%d-PLAINTEXT", f.counter),
		}
		f.slots[id] = slot
		f.order = append(f.order, id)
		created := map[string]any{"slotId": id, "token": slot.token, "nodeId": slot.nodeID}
		if f.opts.modern {
			applied := []string{}
			for _, name := range []string{"proxy", "timezone", "locale", "nodeLabels"} {
				if _, ok := body[name]; ok {
					applied = append(applied, name)
				}
			}
			created["applied"] = applied
		}
		reply(w, 201, asJSON(created))
	case path == "/v1/slots" && r.Method == http.MethodGet:
		if !asOwner {
			reply(w, 401, `{"error":"unauthorized"}`)
			return
		}
		if f.opts.listStatus != 0 && f.opts.listStatus != 200 {
			reply(w, f.opts.listStatus, "")
			return
		}
		list := []map[string]any{}
		for _, id := range f.order {
			if s, ok := f.slots[id]; ok {
				list = append(list, f.summary(s))
			}
		}
		reply(w, 200, asJSON(map[string]any{"slots": list}))
	case path == "/v1/nodes" && r.Method == http.MethodGet:
		if !asOwner {
			reply(w, 401, `{"error":"unauthorized"}`)
			return
		}
		if f.nodesBody != "" {
			reply(w, 200, f.nodesBody)
			return
		}
		reply(w, 200, asJSON(map[string]any{"nodes": []map[string]any{{
			"nodeId": "node-1", "maxContexts": 5, "contexts": len(f.slots), "draining": false, "lastSeenAt": "2026-10-11T11:59:58.000Z",
		}}}))
	case slotPathPattern.MatchString(path):
		slotID := slotPathPattern.FindStringSubmatch(path)[1]
		switch r.Method {
		case http.MethodDelete:
			if !asOwner {
				reply(w, 401, `{"error":"unauthorized"}`)
				return
			}
			status := 204
			if f.opts.deleteStatus != nil {
				status = f.opts.deleteStatus(slotID)
			}
			if status == 204 {
				delete(f.slots, slotID)
			}
			reply(w, status, "")
		case http.MethodGet:
			if len(f.lookups) > 0 {
				scripted := f.lookups[0]
				f.lookups = f.lookups[1:]
				if scripted == "network" {
					panic(http.ErrAbortHandler) // drops the connection
				}
				reply(w, scripted.(int), "")
				return
			}
			slot, ok := f.slots[slotID]
			if !ok {
				reply(w, 404, `{"error":"not_found"}`)
				return
			}
			if r.Header.Get(browserbay.TokenHeader) != slot.token {
				reply(w, 401, `{"error":"unauthorized"}`)
				return
			}
			reply(w, 200, asJSON(f.summary(slot)))
		default:
			reply(w, 404, `{"error":"not_found"}`)
		}
	default:
		reply(w, 404, `{"error":"not_found"}`)
	}
}

// RoundTrip serves a request in-process, so a test can use any address (https://browsers.example.com) without a socket.
func (f *fakeBox) RoundTrip(req *http.Request) (resp *http.Response, err error) {
	rec := httptest.NewRecorder()
	defer func() {
		if r := recover(); r != nil {
			if r == http.ErrAbortHandler {
				resp, err = nil, errors.New("connection dropped")
				return
			}
			panic(r)
		}
	}()
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	f.ServeHTTP(rec, req)
	out := rec.Result()
	out.Request = req
	return out, nil
}

// ---- helpers -------------------------------------------------------------------------------------------------------

func newClient(t *testing.T, f *fakeBox, mutate ...func(*browserbay.Options)) *browserbay.Client {
	t.Helper()
	opts := browserbay.Options{
		URL: box, APIKey: apiKey, HTTPClient: &http.Client{Transport: f},
		Now: func() time.Time { return testNow }, RetryDelay: time.Millisecond,
	}
	for _, m := range mutate {
		m(&opts)
	}
	c, err := browserbay.New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func with(m func(*browserbay.Options)) []func(*browserbay.Options) {
	return []func(*browserbay.Options){m}
}

func acquire(t *testing.T, c *browserbay.Client, runID string) *browserbay.Slot {
	t.Helper()
	slot, err := c.Acquire(context.Background(), browserbay.AcquireOptions{RunID: runID, MaxLifetime: 3000 * time.Second})
	if err != nil {
		t.Fatalf("Acquire(%q): %v", runID, err)
	}
	return slot
}

type recordedWarning struct {
	message string
	fields  map[string]any
}

type recorder struct {
	mu       sync.Mutex
	warnings []recordedWarning
}

func (r *recorder) Warn(message string, fields map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.warnings = append(r.warnings, recordedWarning{message, fields})
}

func equalStrings(t *testing.T, got, want []string, msg string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("%s: got %v, want %v", msg, got, want)
	}
}

func background() context.Context { return context.Background() }

// ---- construction --------------------------------------------------------------------------------------------------

func TestNewRefusesAnAddressOrKeyItCannotUse(t *testing.T) {
	tests := []struct {
		name string
		opts browserbay.Options
		want string
	}{
		{"not a url", browserbay.Options{URL: "not a url", APIKey: apiKey}, "not a URL"},
		{"empty url", browserbay.Options{URL: "", APIKey: apiKey}, "not a URL"},
		{"ftp", browserbay.Options{URL: "ftp://browsers.example.com", APIKey: apiKey}, "http(s)"},
		{"no key", browserbay.Options{URL: box}, "APIKey"},
		{"query", browserbay.Options{URL: box + "?x=1", APIKey: apiKey}, "query"},
		{"credentials", browserbay.Options{URL: "https://user:pw@browsers.example.com", APIKey: apiKey}, "credentials"},
		{"allow list entry with credentials", browserbay.Options{URL: box, APIKey: apiKey, AllowOtherBoxes: []string{"https://u:p@old.example.com"}}, "credentials"},
		{"allow list entry not a url", browserbay.Options{URL: box, APIKey: apiKey, AllowOtherBoxes: []string{"not a url"}}, "not a URL"},
		{"allow list entry ftp", browserbay.Options{URL: box, APIKey: apiKey, AllowOtherBoxes: []string{"ftp://old.example.com"}}, "http(s)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := browserbay.New(tt.opts)
			if !errors.Is(err, browserbay.ErrInvalidArgument) {
				t.Fatalf("want ErrInvalidArgument, got %v", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error %q does not mention %q", err, tt.want)
			}
		})
	}
}

func TestNamespaceMustNotBeMistakableForAnother(t *testing.T) {
	for _, ns := range []string{"app:staging", "has space", "a/b", "é"} {
		if _, err := browserbay.New(browserbay.Options{URL: box, APIKey: apiKey, Namespace: ns}); !errors.Is(err, browserbay.ErrInvalidArgument) {
			t.Errorf("namespace %q: want ErrInvalidArgument, got %v", ns, err)
		}
	}
	for _, ns := range []string{"production", "eu-west_1.app", ""} {
		if _, err := browserbay.New(browserbay.Options{URL: box, APIKey: apiKey, Namespace: ns}); err != nil {
			t.Errorf("namespace %q: %v", ns, err)
		}
	}
}

// ---- acquire -------------------------------------------------------------------------------------------------------

func TestAcquireValidatesBeforeAskingTheBox(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	c := newClient(t, f, with(func(o *browserbay.Options) { o.Namespace = "production" })...)

	tests := []struct {
		name string
		opts browserbay.AcquireOptions
		want string
	}{
		{"empty run id", browserbay.AcquireOptions{MaxLifetime: 600 * time.Second}, "RunID must be"},
		{"run id too long with namespace", browserbay.AcquireOptions{RunID: strings.Repeat("x", 200), MaxLifetime: 600 * time.Second}, "RunID must be"},
		{"lifetime zero", browserbay.AcquireOptions{RunID: "ok"}, "MaxLifetime must be a whole number of seconds from 60 to 86400"},
		{"lifetime 59s", browserbay.AcquireOptions{RunID: "ok", MaxLifetime: 59 * time.Second}, "MaxLifetime must be"},
		{"lifetime too long", browserbay.AcquireOptions{RunID: "ok", MaxLifetime: 86401 * time.Second}, "MaxLifetime must be"},
		{"lifetime fractional", browserbay.AcquireOptions{RunID: "ok", MaxLifetime: 61500 * time.Millisecond}, "MaxLifetime must be"},
		{"lifetime negative", browserbay.AcquireOptions{RunID: "ok", MaxLifetime: -time.Minute}, "MaxLifetime must be"},
		{"wait fractional millisecond", browserbay.AcquireOptions{RunID: "ok", MaxLifetime: 600 * time.Second, Wait: 2500 * time.Microsecond}, "Wait must be a whole number of milliseconds"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.Acquire(background(), tt.opts)
			if !errors.Is(err, browserbay.ErrInvalidArgument) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want ErrInvalidArgument mentioning %q, got %v", tt.want, err)
			}
		})
	}
	if n := len(f.callLog()); n != 0 {
		t.Fatalf("nothing was asked of the box to find that out, but %d calls were made", n)
	}

	// Limits that are allowed.
	edge := []browserbay.AcquireOptions{
		{RunID: "ok", MaxLifetime: 600 * time.Second, Wait: browserbay.NoWait},
		{RunID: strings.Repeat("x", 200-len("production:")), MaxLifetime: browserbay.MinLifetime},
		{RunID: "ok", MaxLifetime: browserbay.MaxLifetime},
	}
	for _, opts := range edge {
		if _, err := c.Acquire(background(), opts); err != nil {
			t.Errorf("Acquire(%d-char run id, %v): %v", len(opts.RunID), opts.MaxLifetime, err)
		}
	}
}

func TestAcquireCountsRunIDLengthInCharacters(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	c := newClient(t, f)
	// 100 astral characters are 200 UTF-16 units: the same length the box measures. 101 are too many.
	if _, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: strings.Repeat("😀", 100), MaxLifetime: 600 * time.Second}); err != nil {
		t.Errorf("100 emoji: %v", err)
	}
	if _, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: strings.Repeat("😀", 101), MaxLifetime: 600 * time.Second}); !errors.Is(err, browserbay.ErrInvalidArgument) {
		t.Errorf("101 emoji: want ErrInvalidArgument, got %v", err)
	}
}

func TestAcquireAsksForASlotWithTheKeyTheWaitAndTheLifetime(t *testing.T) {
	tests := []struct {
		name     string
		wait     time.Duration
		wantWait float64
	}{
		{"default wait is 30 seconds", 0, 30000},
		{"explicit wait", 5 * time.Second, 5000},
		{"NoWait sends zero, not the default", browserbay.NoWait, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeBox(fakeOptions{})
			c := newClient(t, f, with(func(o *browserbay.Options) { o.URL = box + "/" })...)
			if _, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "run-1", MaxLifetime: 3000 * time.Second, Wait: tt.wait}); err != nil {
				t.Fatal(err)
			}
			create := f.callLog()[0]
			if create.Method != "POST" || create.URL != box+"/v1/slots" {
				t.Errorf("request: %s %s", create.Method, create.URL)
			}
			if got := create.Header.Get("Authorization"); got != "Bearer "+apiKey {
				t.Errorf("Authorization: %q", got)
			}
			if got := create.Header.Get("Content-Type"); got != "application/json" {
				t.Errorf("Content-Type: %q", got)
			}
			want := map[string]any{"runId": "run-1", "maxLifetimeSeconds": 3000.0, "waitMs": tt.wantWait}
			if asJSON(create.Body) != asJSON(want) {
				t.Errorf("body: %v, want %v", create.Body, want)
			}
		})
	}
}

func TestAcquireWithANamespacePrefixesTheRunID(t *testing.T) {
	tests := []struct {
		namespace string
		want      string
	}{{"production", "production:run-1"}, {"", "run-1"}}
	for _, tt := range tests {
		t.Run("namespace="+tt.namespace, func(t *testing.T) {
			f := newFakeBox(fakeOptions{})
			c := newClient(t, f, with(func(o *browserbay.Options) { o.Namespace = tt.namespace })...)
			acquire(t, c, "run-1")
			if got := f.callLog()[0].Body["runId"]; got != tt.want {
				t.Errorf("runId sent: %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSlotCarriesWhatItTakesToDriveAndReleaseItsBrowser(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	c := newClient(t, f, with(func(o *browserbay.Options) { o.URL = box + "/" })...)
	slot := acquire(t, c, "run-1")
	token := f.token("slot-1")

	if slot.URL != box {
		t.Errorf("URL %q: the trailing slash should be dropped", slot.URL)
	}
	if slot.SlotID != "slot-1" || slot.NodeID != "node-1" || slot.Token != token {
		t.Errorf("slot: %+v", slot)
	}
	if want := "wss://browsers.example.com/v1/cdp/slot-1"; slot.CDPURL != want {
		t.Errorf("CDPURL %q, want %q", slot.CDPURL, want)
	}
	h := slot.Headers()
	if got := h.Get(browserbay.TokenHeader); got != token || len(h) != 1 {
		t.Errorf("Headers: %v", h)
	}
	h.Set(browserbay.TokenHeader, "tampered")
	h.Set("X-Other", "1")
	if got := slot.Headers(); got.Get(browserbay.TokenHeader) != token || got.Get("X-Other") != "" {
		t.Errorf("Headers must be fresh on every call, got %v", got)
	}
	if data, _ := json.Marshal(slot); strings.Contains(string(data), apiKey) {
		t.Error("the API key is part of a slot")
	}
	if second := acquire(t, c, "run-2"); second.Token == token {
		t.Error("each slot has its own token")
	}
}

func TestAcquireFailures(t *testing.T) {
	t.Run("a full box is ErrNoCapacity and an *Error with status 503", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{createStatus: 503}))
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		var apiErr *browserbay.Error
		if !errors.Is(err, browserbay.ErrNoCapacity) || !errors.As(err, &apiErr) || apiErr.Status != 503 {
			t.Fatalf("got %#v", err)
		}
		if apiErr.Code != "no_capacity" || !strings.Contains(err.Error(), "no browser capacity is available right now") {
			t.Errorf("error: %v (code %q)", err, apiErr.Code)
		}
	})
	t.Run("a key confined to another namespace is ErrForbidden, told apart from a full box", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{createStatus: 403}))
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		var apiErr *browserbay.Error
		if !errors.Is(err, browserbay.ErrForbidden) || errors.Is(err, browserbay.ErrNoCapacity) || !errors.As(err, &apiErr) || apiErr.Status != 403 {
			t.Fatalf("got %#v", err)
		}
		if apiErr.Code != "forbidden" || !strings.Contains(err.Error(), "namespace") || strings.Contains(err.Error(), apiKey) {
			t.Errorf("error: %v (code %q)", err, apiErr.Code)
		}
	})
	t.Run("an exhausted quota is ErrQuotaExceeded, told apart from a full box", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{createStatus: 429}))
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		var apiErr *browserbay.Error
		if !errors.Is(err, browserbay.ErrQuotaExceeded) || errors.Is(err, browserbay.ErrNoCapacity) || !errors.As(err, &apiErr) || apiErr.Status != 429 {
			t.Fatalf("got %#v", err)
		}
		if apiErr.Code != "quota_exceeded" || strings.Contains(err.Error(), apiKey) {
			t.Errorf("error: %v (code %q)", err, apiErr.Code)
		}
	})
	t.Run("other statuses carry the status and no secret", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{createStatus: 401}))
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		var apiErr *browserbay.Error
		if !errors.As(err, &apiErr) || errors.Is(err, browserbay.ErrNoCapacity) || apiErr.Status != 401 {
			t.Fatalf("got %#v", err)
		}
		if !strings.Contains(err.Error(), "could not start a browser (401)") || strings.Contains(err.Error(), apiKey) {
			t.Errorf("message: %q", err)
		}
	})
	t.Run("an incomplete slot", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{createBody: `{"slotId":"slot-1"}`}))
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		var apiErr *browserbay.Error
		if !errors.As(err, &apiErr) || !strings.Contains(err.Error(), "incomplete slot") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a box that cannot be reached", func(t *testing.T) {
		boom := errors.New("connection refused")
		c := newClient(t, nil, with(func(o *browserbay.Options) {
			o.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, boom })}
		})...)
		_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour})
		if !errors.Is(err, boom) {
			t.Fatalf("the cause should be reachable with errors.Is, got %v", err)
		}
	})
	t.Run("a cancelled context", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{}))
		ctx, cancel := context.WithCancel(background())
		cancel()
		if _, err := c.Acquire(ctx, browserbay.AcquireOptions{RunID: "r", MaxLifetime: time.Hour}); !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCDPURLFollowsTheBoxAddress(t *testing.T) {
	tests := []struct{ url, want string }{
		{"http://box.internal:8080", "ws://box.internal:8080/v1/cdp/slot-1"},
		{"https://box.example.com", "wss://box.example.com/v1/cdp/slot-1"},
		{"https://box.example.com:8443", "wss://box.example.com:8443/v1/cdp/slot-1"},
		{"https://example.com/browsers", "wss://example.com/browsers/v1/cdp/slot-1"},
		{"https://example.com/browsers/", "wss://example.com/browsers/v1/cdp/slot-1"},
		{"HTTPS://Example.COM:443/browsers//", "wss://example.com/browsers/v1/cdp/slot-1"},
		{"http://example.com:80", "ws://example.com/v1/cdp/slot-1"},
		{"http://[::1]:8788", "ws://[::1]:8788/v1/cdp/slot-1"},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			c := newClient(t, newFakeBox(fakeOptions{}), with(func(o *browserbay.Options) { o.URL = tt.url })...)
			slot, err := c.Slot(browserbay.StoredSlot{SlotID: "slot-1", Token: "t"})
			if err != nil {
				t.Fatal(err)
			}
			if slot.CDPURL != tt.want {
				t.Errorf("got %q, want %q", slot.CDPURL, tt.want)
			}
		})
	}

	t.Run("lookups go under the same prefix", func(t *testing.T) {
		f := newFakeBox(fakeOptions{prefix: "/browsers"})
		c := newClient(t, f, with(func(o *browserbay.Options) { o.URL = box + "/browsers/" })...)
		slot := acquire(t, c, "run-1")
		if slot.CDPURL != "wss://browsers.example.com/browsers/v1/cdp/slot-1" || !slot.IsAlive(background()) {
			t.Errorf("slot %+v", slot)
		}
	})
	t.Run("a slot id is escaped", func(t *testing.T) {
		c := newClient(t, newFakeBox(fakeOptions{}))
		slot, _ := c.Slot(browserbay.StoredSlot{SlotID: "a/b c", Token: "t"})
		if want := "wss://browsers.example.com/v1/cdp/a%2Fb%20c"; slot.CDPURL != want {
			t.Errorf("got %q, want %q", slot.CDPURL, want)
		}
	})
}

// ---- liveness ------------------------------------------------------------------------------------------------------

func TestIsAliveAsksWithTheSlotsOwnTokenNeverTheAPIKey(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	slot := acquire(t, newClient(t, f), "run-1")
	if !slot.IsAlive(background()) {
		t.Fatal("not alive")
	}
	lookup := f.lookupCalls()[0]
	if lookup.URL != box+"/v1/slots/slot-1" || lookup.Header.Get(browserbay.TokenHeader) != f.token("slot-1") {
		t.Errorf("lookup: %+v", lookup)
	}
	if lookup.Header.Get("Authorization") != "" {
		t.Error("a slot asks about itself without the API key")
	}
}

func TestIsAliveIsFalseWhenTheSlotIsGoneOrItsTokenRefusedAndThatIsFinal(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	slot := acquire(t, newClient(t, f), "run-1")

	f.setToken("slot-1", "a-completely-different-token")
	if slot.IsAlive(background()) {
		t.Error("401: the slot now belongs to another run")
	}
	if n := len(f.lookupCalls()); n != 1 {
		t.Errorf("a refusal is not retried, but there were %d lookups", n)
	}
	f.clear()
	if slot.IsAlive(background()) {
		t.Error("404: the slot is gone")
	}
	if n := len(f.lookupCalls()); n != 2 {
		t.Errorf("lookups: %d", n)
	}
}

func TestIsAliveRetriesOnceOnANetworkErrorOrAServerErrorAndNeverFails(t *testing.T) {
	tests := []struct {
		name        string
		lookups     []any
		wantAlive   bool
		wantLookups int
	}{
		{"network then ok", []any{"network"}, true, 2},
		{"500 then ok", []any{500}, true, 2},
		{"503 then ok", []any{503}, true, 2},
		{"network twice", []any{"network", "network"}, false, 2},
		{"502 then network", []any{502, "network"}, false, 2},
		{"404 is final", []any{404}, false, 1},
		{"401 is final", []any{401}, false, 1},
		{"ok at once", nil, true, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeBox(fakeOptions{slotLookups: tt.lookups})
			slot := acquire(t, newClient(t, f), "run-1")
			if got := slot.IsAlive(background()); got != tt.wantAlive {
				t.Errorf("alive: %v, want %v", got, tt.wantAlive)
			}
			if got := len(f.lookupCalls()); got != tt.wantLookups {
				t.Errorf("lookups: %d, want %d", got, tt.wantLookups)
			}
		})
	}
}

func TestIsAlivePausesBetweenItsTwoAsksAndHonoursItsContext(t *testing.T) {
	f := newFakeBox(fakeOptions{slotLookups: []any{500}})
	c := newClient(t, f, with(func(o *browserbay.Options) { o.RetryDelay = 40 * time.Millisecond })...)
	slot := acquire(t, c, "run-1")
	start := time.Now()
	if !slot.IsAlive(background()) {
		t.Fatal("not alive")
	}
	if elapsed := time.Since(start); elapsed < 40*time.Millisecond {
		t.Errorf("no pause between the asks: %v", elapsed)
	}

	// A caller that gives up during the pause gets "not alive" at once, without a second ask.
	g := newFakeBox(fakeOptions{slotLookups: []any{500}})
	slow := newClient(t, g, with(func(o *browserbay.Options) { o.RetryDelay = time.Hour })...)
	slot = acquire(t, slow, "run-1")
	ctx, cancel := context.WithTimeout(background(), 30*time.Millisecond)
	defer cancel()
	if slot.IsAlive(ctx) {
		t.Error("alive after the context ended")
	}
	if n := len(g.lookupCalls()); n != 1 {
		t.Errorf("lookups: %d", n)
	}

	var zero browserbay.Slot
	if zero.IsAlive(background()) {
		t.Error("a zero Slot cannot be alive")
	}
}

// ---- stored slots --------------------------------------------------------------------------------------------------

func TestAStoredSlotComesBackWithoutARequestAndSaysWhereItLives(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	original := acquire(t, newClient(t, f), "run-1")

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]string
	if err := json.Unmarshal(data, &keys); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(keys))
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	equalStrings(t, names, []string{"nodeId", "slotId", "token", "url"}, "stored form keys")
	if strings.Contains(string(data), apiKey) {
		t.Error("the API key is in the stored form")
	}
	if keys["url"] != box || keys["slotId"] != "slot-1" || keys["nodeId"] != "node-1" || keys["token"] != original.Token {
		t.Errorf("stored form: %s", data)
	}
	// Marshalling a value gives the same form as marshalling a pointer.
	if value, _ := json.Marshal(*original); string(value) != string(data) {
		t.Errorf("value form %s differs from %s", value, data)
	}

	var stored browserbay.StoredSlot
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	before := len(f.callLog())
	revived, err := newClient(t, f).Slot(stored)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.callLog()) != before {
		t.Error("nothing is asked of the box just to rebuild a slot")
	}
	if revived.CDPURL != original.CDPURL || revived.Headers().Get(browserbay.TokenHeader) != original.Headers().Get(browserbay.TokenHeader) {
		t.Errorf("revived %+v differs from %+v", revived, original)
	}
	if !revived.IsAlive(background()) {
		t.Error("a revived slot of a live browser is alive")
	}
	if again, _ := json.Marshal(revived); string(again) != string(data) {
		t.Errorf("round trip: %s != %s", again, data)
	}
	if original.Stored() != stored {
		t.Errorf("Stored(): %+v", original.Stored())
	}
}

func TestSlotRefusesWhatCannotBeUsed(t *testing.T) {
	c := newClient(t, newFakeBox(fakeOptions{}))
	tests := []struct {
		name   string
		stored browserbay.StoredSlot
		want   string
	}{
		{"no token", browserbay.StoredSlot{SlotID: "slot-1"}, "SlotID and a Token"},
		{"no slot id", browserbay.StoredSlot{Token: "x"}, "SlotID and a Token"},
		{"ftp", browserbay.StoredSlot{SlotID: "s", Token: "t", URL: "ftp://browsers.example.com"}, "http(s)"},
		{"not a url", browserbay.StoredSlot{SlotID: "s", Token: "t", URL: "not a url"}, "not a URL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.Slot(tt.stored)
			if !errors.Is(err, browserbay.ErrInvalidArgument) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

// ---- credentials stay with the boxes the client may talk to ---------------------------------------------------------

func TestAStoredSlotThatNamesAnotherBoxIsNotTrustedWithTheKeyOrTheToken(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	c := newClient(t, f)
	stored := browserbay.StoredSlot{SlotID: "slot-1", Token: "a-slot-token", URL: "https://attacker.example.net"}

	if _, err := c.Slot(stored); !errors.Is(err, browserbay.ErrUntrustedBox) || !strings.Contains(err.Error(), "not on this client's box") {
		t.Fatalf("Slot: %v", err)
	}
	if err := c.ReleaseAt(background(), stored.URL, "slot-1"); !errors.Is(err, browserbay.ErrUntrustedBox) || !strings.Contains(err.Error(), "credentials are only sent to the box") {
		t.Fatalf("ReleaseAt: %v", err)
	}
	if n := len(f.callLog()); n != 0 {
		t.Fatalf("nothing was sent anywhere, but %d calls were", n)
	}

	// The same box under another spelling is the same box; another path on the host is another box.
	if s, err := c.Slot(browserbay.StoredSlot{SlotID: "s", Token: "t", URL: box + "/"}); err != nil || s.URL != box {
		t.Errorf("same box with a slash: %v %v", s, err)
	}
	for _, url := range []string{box + "/other-prefix", "HTTPS://Browsers.Example.COM:443/", "https://browsers.example.com/x/.."} {
		_, err := c.Slot(browserbay.StoredSlot{SlotID: "s", Token: "t", URL: url})
		same := url != box+"/other-prefix"
		if same && err != nil {
			t.Errorf("%s is this box spelled another way: %v", url, err)
		}
		if !same && !errors.Is(err, browserbay.ErrUntrustedBox) {
			t.Errorf("%s is another box: %v", url, err)
		}
	}
	if s, _ := c.Slot(browserbay.StoredSlot{SlotID: "s", Token: "t"}); s.URL != box {
		t.Error("no address means this client's box")
	}

	trusting := newClient(t, f, with(func(o *browserbay.Options) { o.AllowAnyBox = true })...)
	if s, err := trusting.Slot(stored); err != nil || s.URL != stored.URL {
		t.Errorf("AllowAnyBox: %v %v", s, err)
	}
}

func TestAllowOtherBoxesNamesTheBoxesAStoredSlotMayLiveOnAndOnlyThose(t *testing.T) {
	const old = "https://old-box.example.com"
	f := newFakeBox(fakeOptions{})
	c := newClient(t, f, with(func(o *browserbay.Options) {
		o.AllowOtherBoxes = []string{old, "https://other-old.example.com/prefix"}
	})...)
	stored := func(url string) browserbay.StoredSlot {
		return browserbay.StoredSlot{SlotID: "s1", Token: "t1", URL: url}
	}

	allowed := []struct{ url, wantURL, wantCDP string }{
		{old, old, "wss://old-box.example.com/v1/cdp/s1"},
		{"HTTPS://Old-Box.Example.com:443/", "HTTPS://Old-Box.Example.com:443", "wss://old-box.example.com/v1/cdp/s1"},
		{"https://other-old.example.com/prefix/", "https://other-old.example.com/prefix", "wss://other-old.example.com/prefix/v1/cdp/s1"},
		{"", box, "wss://browsers.example.com/v1/cdp/s1"},
	}
	for _, a := range allowed {
		s, err := c.Slot(stored(a.url))
		if err != nil {
			t.Errorf("%q: %v", a.url, err)
			continue
		}
		if s.URL != a.wantURL || s.CDPURL != a.wantCDP {
			t.Errorf("%q: URL %q CDPURL %q", a.url, s.URL, s.CDPURL)
		}
	}

	for _, url := range []string{
		"https://attacker.example.net", old + ":8443", "http://old-box.example.com",
		"https://other-old.example.com", "https://other-old.example.com/prefix/deeper",
	} {
		if _, err := c.Slot(stored(url)); !errors.Is(err, browserbay.ErrUntrustedBox) {
			t.Errorf("Slot(%s): %v", url, err)
		}
		if err := c.ReleaseAt(background(), url, "s1"); !errors.Is(err, browserbay.ErrUntrustedBox) {
			t.Errorf("ReleaseAt(%s): %v", url, err)
		}
	}
	if n := len(f.callLog()); n != 0 {
		t.Fatalf("nothing was sent to any of them, but %d calls were", n)
	}

	// A listed box really is where the call goes, with the API key.
	if err := c.ReleaseAt(background(), old, "s1"); err != nil {
		t.Fatal(err)
	}
	first := f.callLog()[0]
	if first.URL != old+"/v1/slots/s1" || first.Header.Get("Authorization") != "Bearer "+apiKey {
		t.Errorf("call: %+v", first)
	}

	// An empty list trusts nobody.
	none := newClient(t, f, with(func(o *browserbay.Options) { o.AllowOtherBoxes = []string{} })...)
	if _, err := none.Slot(stored(old)); !errors.Is(err, browserbay.ErrUntrustedBox) {
		t.Errorf("empty list: %v", err)
	}
}

func TestAStoredSlotIsReleasedAtTheBoxItNames(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	slot := acquire(t, newClient(t, f), "run-1")
	stored := slot.Stored()
	if err := slot.Release(background()); err != nil {
		t.Fatal(err)
	}
	del := f.callLog()[len(f.callLog())-1]
	if del.Method != "DELETE" || del.URL != box+"/v1/slots/slot-1" || del.Header.Get("Authorization") != "Bearer "+apiKey {
		t.Errorf("delete: %+v", del)
	}
	if len(f.slotIDs()) != 0 {
		t.Error("the slot is still on the box")
	}
	if slot.IsAlive(background()) {
		t.Error("a released slot is gone")
	}

	// The box moved since the slot was stored: the slot still decides where it lives.
	elsewhere := newFakeBox(fakeOptions{})
	moved := newClient(t, elsewhere, with(func(o *browserbay.Options) {
		o.URL = "https://new-box.example.com"
		o.AllowOtherBoxes = []string{box}
	})...)
	revived, err := moved.Slot(stored)
	if err != nil {
		t.Fatal(err)
	}
	if err := revived.Release(background()); err != nil {
		t.Fatal(err)
	}
	got := elsewhere.callLog()[0]
	if got.URL != box+"/v1/slots/slot-1" || got.Header.Get("Authorization") != "Bearer "+apiKey {
		t.Errorf("call: %+v", got)
	}
}

// ---- release -------------------------------------------------------------------------------------------------------

func TestReleaseIsIdempotentAndAFailureIsReturnedWithItsStatus(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	slot := acquire(t, newClient(t, f), "run-1")
	for i := 0; i < 2; i++ {
		if err := slot.Release(background()); err != nil {
			t.Fatalf("release %d: %v", i+1, err)
		}
	}
	if n := len(f.deleted()); n != 2 {
		t.Errorf("deletes: %d", n)
	}

	gone := newFakeBox(fakeOptions{deleteStatus: func(string) int { return 404 }})
	revived, _ := newClient(t, gone).Slot(slot.Stored())
	if err := revived.Release(background()); err != nil {
		t.Errorf("a slot that is already gone is fine: %v", err)
	}

	for _, status := range []int{500, 401} {
		failing := newFakeBox(fakeOptions{deleteStatus: func(string) int { return status }})
		revived, _ := newClient(t, failing).Slot(slot.Stored())
		err := revived.Release(background())
		var apiErr *browserbay.Error
		if !errors.As(err, &apiErr) || apiErr.Status != status {
			t.Fatalf("status %d: got %v", status, err)
		}
		if strings.Contains(err.Error(), apiKey) || strings.Contains(err.Error(), slot.Token) {
			t.Errorf("a secret is in %q", err)
		}
	}
}

func TestReleaseByIDAlone(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.seed("orphan", "run-a", 30)
	c := newClient(t, f)
	if err := c.Release(background(), "orphan"); err != nil {
		t.Fatal(err)
	}
	equalStrings(t, f.deleted(), []string{"orphan"}, "deleted")
	first := f.callLog()[0]
	if first.URL != box+"/v1/slots/orphan" || first.Header.Get("Authorization") != "Bearer "+apiKey {
		t.Errorf("call: %+v", first)
	}

	if err := newClient(t, newFakeBox(fakeOptions{deleteStatus: func(string) int { return 404 }})).Release(background(), "already-gone"); err != nil {
		t.Errorf("404: %v", err)
	}
	err := newClient(t, newFakeBox(fakeOptions{deleteStatus: func(string) int { return 500 }})).Release(background(), "stuck")
	var apiErr *browserbay.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 500 {
		t.Errorf("500: %v", err)
	}
	if err := c.Release(background(), ""); !errors.Is(err, browserbay.ErrInvalidArgument) || !strings.Contains(err.Error(), "needs a slotID") {
		t.Errorf("empty id: %v", err)
	}
	if err := c.ReleaseAt(background(), "ftp://nope", "x"); !errors.Is(err, browserbay.ErrInvalidArgument) {
		t.Errorf("bad address: %v", err)
	}
	if err := newClient(t, f, with(func(o *browserbay.Options) { o.AllowAnyBox = true })...).ReleaseAt(background(), "https://other.example.com/", "x"); err != nil {
		// The in-process transport answers for any host, so this succeeds and shows where it went.
		t.Errorf("AllowAnyBox release: %v", err)
	}
	if last := f.callLog()[len(f.callLog())-1]; last.URL != "https://other.example.com/v1/slots/x" {
		t.Errorf("went to %s", last.URL)
	}
}

// ---- list and nodes ------------------------------------------------------------------------------------------------

func TestListShowsThisServicesSlotsAndWithANamespaceOnlyThatOneWithThePrefixRemoved(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.seed("mine", "production:run-a", 30)
	f.seed("theirs", "staging:run-a", 30)
	f.seed("bare", "run-a", 30)

	all, err := newClient(t, f).List(background())
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, s := range all {
		ids = append(ids, s.SlotID)
	}
	sort.Strings(ids)
	equalStrings(t, ids, []string{"bare", "mine", "theirs"}, "no namespace sees everything")

	listed, err := newClient(t, f, with(func(o *browserbay.Options) { o.Namespace = "production" })...).List(background())
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].SlotID != "mine" || listed[0].RunID != "run-a" || listed[0].NodeID != "node-1" {
		t.Errorf("listed: %+v", listed)
	}
	if want := testNow.Add(-30 * time.Minute); !listed[0].CreatedAt.Equal(want) {
		t.Errorf("CreatedAt %v, want %v", listed[0].CreatedAt, want)
	}
	if data, _ := json.Marshal(listed); strings.Contains(string(data), "token") {
		t.Error("a listing carries no secret")
	}

	for _, status := range []int{500, 401} {
		_, err := newClient(t, newFakeBox(fakeOptions{listStatus: status})).List(background())
		var apiErr *browserbay.Error
		if !errors.As(err, &apiErr) || apiErr.Status != status || !strings.Contains(err.Error(), fmt.Sprintf("could not list browsers (%d)", status)) {
			t.Errorf("status %d: %v", status, err)
		}
	}
}

func TestListSkipsEntriesItCannotUse(t *testing.T) {
	c := newClient(t, nil, with(func(o *browserbay.Options) {
		o.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			rec := httptest.NewRecorder()
			reply(rec, 200, `{"slots":[
				{"slotId":"ok","runId":"r","nodeId":"n","createdAt":"not a time"},
				{"runId":"no-id"},
				{"slotId":"no-run"},
				{"slotId":"bad-types","runId":7},
				{"slotId":"empty-run","runId":"","nodeId":"n"}]}`)
			return rec.Result(), nil
		})}
	})...)
	got, err := c.List(background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].SlotID != "ok" || got[1].SlotID != "empty-run" || !got[0].CreatedAt.IsZero() {
		t.Errorf("got %+v", got)
	}
}

func TestNodesListsTheMachinesThatRunTheBoxesBrowsers(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.seed("a", "run", 1)
	nodes, err := newClient(t, f).Nodes(background())
	if err != nil {
		t.Fatal(err)
	}
	want := browserbay.NodeSummary{NodeID: "node-1", MaxContexts: 5, Contexts: 1, LastSeenAt: time.Date(2026, 10, 11, 11, 59, 58, 0, time.UTC)}
	if len(nodes) != 1 || asJSON(nodes[0]) != asJSON(want) {
		t.Errorf("nodes: %+v, want %+v", nodes, want)
	}
	if got := f.callLog()[0].Header.Get("Authorization"); got != "Bearer "+apiKey {
		t.Errorf("Authorization: %q", got)
	}
	_, err = newClient(t, nil, with(func(o *browserbay.Options) {
		o.HTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			rec := httptest.NewRecorder()
			reply(rec, 401, "")
			return rec.Result(), nil
		})}
	})...).Nodes(background())
	var apiErr *browserbay.Error
	if !errors.As(err, &apiErr) || apiErr.Status != 401 {
		t.Errorf("401: %v", err)
	}
}

// ---- reap ----------------------------------------------------------------------------------------------------------

func TestReapReleasesSlotsNoLiveRunNeedsAndSparesYoungOnesLiveRunsAndTheSkipped(t *testing.T) {
	rec := &recorder{}
	f := newFakeBox(fakeOptions{})
	f.seed("live", "run-live", 30)
	f.seed("finished", "run-finished", 30)
	f.seed("lost", "run-missing", 30)
	f.seed("young", "run-finished", 1)
	f.seed("capture", "capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427", 30)
	f.seed("broken", "run-broken", 30)
	f.seed("anonymous", "", 30)
	c := newClient(t, f, with(func(o *browserbay.Options) { o.Logger = rec })...)

	var asked []string
	released, err := c.Reap(background(), browserbay.ReapOptions{
		IsLive: func(_ context.Context, runID string) (bool, error) {
			asked = append(asked, runID)
			if runID == "run-broken" {
				return false, errors.New("invalid input syntax for type uuid")
			}
			return runID == "run-live", nil
		},
		Skip: func(runID string) bool { return strings.HasPrefix(runID, "capture-") },
	})
	if err != nil {
		t.Fatal(err)
	}
	list := f.callLog()[0]
	if list.Method != "GET" || list.URL != box+"/v1/slots" || list.Header.Get("Authorization") != "Bearer "+apiKey {
		t.Errorf("list call: %+v", list)
	}
	deleted := f.deleted()
	sort.Strings(deleted)
	equalStrings(t, deleted, []string{"anonymous", "finished", "lost"}, "released")
	if released != 3 {
		t.Errorf("released %d", released)
	}
	equalStrings(t, asked, []string{"run-live", "run-finished", "run-missing", "run-broken"},
		"young slots, skipped ones and slots without a run are not looked up")
	equalStrings(t, f.slotIDs(), []string{"broken", "capture", "live", "young"}, "not knowing is not a reason to release a browser")
	if len(rec.warnings) != 1 || rec.warnings[0].fields["slotId"] != "broken" {
		t.Errorf("the failed lookup is logged: %+v", rec.warnings)
	}
	for _, c := range f.callLog() {
		if c.Method == "DELETE" && c.Header.Get("Authorization") != "Bearer "+apiKey {
			t.Errorf("a release without the API key: %+v", c)
		}
	}
}

func TestReapWithANamespaceOnlyTouchesThatNamespaceAndAsksAboutTheBareRunID(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.seed("mine-orphan", "production:run-orphan", 30)
	f.seed("mine-live", "production:run-live", 30)
	f.seed("mine-capture", "production:capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427", 30)
	f.seed("mine-young", "production:run-orphan", 1)
	f.seed("staging", "staging:run-orphan", 30)
	f.seed("unprefixed", "run-orphan", 30)
	f.seed("lookalike", "production-eu:run-orphan", 30)
	c := newClient(t, f, with(func(o *browserbay.Options) { o.Namespace = "production" })...)

	var asked []string
	released, err := c.Reap(background(), browserbay.ReapOptions{
		IsLive: func(_ context.Context, runID string) (bool, error) {
			asked = append(asked, runID)
			return runID == "run-live", nil
		},
		Skip: func(runID string) bool { return strings.HasPrefix(runID, "capture-") },
	})
	if err != nil {
		t.Fatal(err)
	}
	equalStrings(t, f.deleted(), []string{"mine-orphan"}, "released")
	if released != 1 {
		t.Errorf("released %d", released)
	}
	equalStrings(t, asked, []string{"run-orphan", "run-live"}, "the namespace prefix is stripped before the run is looked up")
	equalStrings(t, f.slotIDs(), []string{"lookalike", "mine-capture", "mine-live", "mine-young", "staging", "unprefixed"},
		"another service's slots on a shared box are untouched")
}

func TestReapSparesASlotDuringTheGracePeriodAndReapsItAfter(t *testing.T) {
	clock := testNow
	f := newFakeBox(fakeOptions{now: func() time.Time { return clock }})
	c := newClient(t, f, with(func(o *browserbay.Options) {
		o.Namespace = "production"
		o.Now = func() time.Time { return clock }
	})...)
	acquire(t, c, "run-1")
	never := func(context.Context, string) (bool, error) { return false, nil }

	clock = testNow.Add(time.Minute)
	if n, err := c.Reap(background(), browserbay.ReapOptions{IsLive: never}); err != nil || n != 0 || len(f.slotIDs()) != 1 {
		t.Fatalf("one minute old: it may not be saved on its run yet: %d %v", n, err)
	}

	clock = testNow.Add(10 * time.Minute)
	var asked []string
	n, err := c.Reap(background(), browserbay.ReapOptions{IsLive: func(_ context.Context, runID string) (bool, error) {
		asked = append(asked, runID)
		return false, nil
	}})
	if err != nil || n != 1 || len(f.slotIDs()) != 0 {
		t.Fatalf("after the grace period: %d %v", n, err)
	}
	equalStrings(t, asked, []string{"run-1"}, "asked")

	g := newFakeBox(fakeOptions{now: func() time.Time { return clock }})
	strict := newClient(t, g, with(func(o *browserbay.Options) { o.Now = func() time.Time { return clock } })...)
	acquire(t, strict, "run-2")
	clock = clock.Add(10 * time.Minute)
	if n, _ := strict.Reap(background(), browserbay.ReapOptions{IsLive: never, Grace: 30 * time.Minute}); n != 0 {
		t.Error("the grace period is configurable")
	}
	if n, _ := strict.Reap(background(), browserbay.ReapOptions{IsLive: never, Grace: browserbay.NoGrace}); n != 1 {
		t.Error("NoGrace reaps a slot of any age")
	}
}

func TestReapAFailedListingStopsItAndAFailedReleaseIsNotCountedAndLogsNoSecret(t *testing.T) {
	unavailable := newFakeBox(fakeOptions{listStatus: 500})
	unavailable.seed("orphan", "run-orphan", 30)
	_, err := newClient(t, unavailable).Reap(background(), browserbay.ReapOptions{IsLive: func(context.Context, string) (bool, error) { return false, nil }})
	if err == nil || !strings.Contains(err.Error(), "could not list browsers (500)") {
		t.Fatalf("got %v", err)
	}
	if len(unavailable.deleted()) != 0 {
		t.Error("nothing is released on a listing that failed")
	}

	rec := &recorder{}
	f := newFakeBox(fakeOptions{deleteStatus: func(id string) int {
		if id == "stuck" {
			return 500
		}
		return 204
	}})
	f.seed("stuck", "run-a", 30)
	f.seed("fine", "run-b", 30)
	released, err := newClient(t, f, with(func(o *browserbay.Options) { o.Logger = rec })...).Reap(background(),
		browserbay.ReapOptions{IsLive: func(context.Context, string) (bool, error) { return false, nil }})
	if err != nil || released != 1 {
		t.Fatalf("only the release that worked is counted: %d %v", released, err)
	}
	equalStrings(t, f.deleted(), []string{"stuck", "fine"}, "one failure does not stop the others")
	logged := fmt.Sprint(rec.warnings)
	if len(rec.warnings) != 1 || !strings.Contains(logged, "stuck") {
		t.Errorf("warnings: %v", logged)
	}
	if strings.Contains(logged, apiKey) || strings.Contains(logged, "token-of-") {
		t.Errorf("a secret is logged: %v", logged)
	}
}

func TestReapNeedsAnIsLiveAndStopsWhenItsContextEnds(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.seed("a", "run-a", 30)
	f.seed("b", "run-b", 30)
	c := newClient(t, f)
	if _, err := c.Reap(background(), browserbay.ReapOptions{}); !errors.Is(err, browserbay.ErrInvalidArgument) {
		t.Errorf("no IsLive: %v", err)
	}

	ctx, cancel := context.WithCancel(background())
	n, err := c.Reap(ctx, browserbay.ReapOptions{IsLive: func(context.Context, string) (bool, error) {
		cancel() // after the first slot is checked
		return false, nil
	}})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err: %v", err)
	}
	if n > 1 {
		t.Errorf("released %d after cancellation", n)
	}
}

func TestLoggerFuncAdaptsAFunction(t *testing.T) {
	var got string
	var l browserbay.Logger = browserbay.LoggerFunc(func(message string, _ map[string]any) { got = message })
	l.Warn("hello", nil)
	if got != "hello" {
		t.Errorf("got %q", got)
	}
}

// ---- over a real socket --------------------------------------------------------------------------------------------

func TestAgainstARealHTTPServerUnderAPathPrefix(t *testing.T) {
	f := newFakeBox(fakeOptions{prefix: "/browsers", slotLookups: []any{"network"}})
	server := httptest.NewServer(f)
	defer server.Close()

	c, err := browserbay.New(browserbay.Options{URL: server.URL + "/browsers/", APIKey: apiKey, Namespace: "svc", RetryDelay: browserbay.NoRetryDelay})
	if err != nil {
		t.Fatal(err)
	}
	slot, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "run-1", MaxLifetime: time.Hour, Wait: browserbay.NoWait})
	if err != nil {
		t.Fatal(err)
	}
	if want := "ws://" + strings.TrimPrefix(server.URL, "http://") + "/browsers/v1/cdp/slot-1"; slot.CDPURL != want {
		t.Errorf("CDPURL %q, want %q", slot.CDPURL, want)
	}
	if !slot.IsAlive(background()) {
		t.Error("the first ask is dropped by the box; the second one must be answered")
	}
	listed, err := c.List(background())
	if err != nil || len(listed) != 1 || listed[0].RunID != "run-1" {
		t.Errorf("list: %+v %v", listed, err)
	}
	if err := slot.Release(background()); err != nil {
		t.Fatal(err)
	}
	if slot.IsAlive(background()) {
		t.Error("released")
	}
}

func TestTheDefaultHTTPClientDoesNotFollowARedirectToAnotherHost(t *testing.T) {
	var reached atomic.Bool
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer elsewhere.Close()
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer redirecting.Close()

	c, _ := browserbay.New(browserbay.Options{URL: redirecting.URL, APIKey: apiKey})
	if _, err := c.List(background()); err == nil {
		t.Error("expected an error")
	}
	slot, _ := c.Slot(browserbay.StoredSlot{SlotID: "s", Token: "t"})
	if slot.IsAlive(background()) {
		t.Error("alive")
	}
	if reached.Load() {
		t.Error("the redirect was followed to another host, with credentials")
	}
}

func TestErrorsReadWell(t *testing.T) {
	var err error = &browserbay.Error{Status: 418, Message: "teapot"}
	if err.Error() != "browserbay: teapot" {
		t.Errorf("got %q", err)
	}
	wrapped := fmt.Errorf("outer: %w", err)
	var apiErr *browserbay.Error
	if !errors.As(wrapped, &apiErr) || apiErr.Status != 418 {
		t.Error("errors.As")
	}
}

// ---- slot options ----------------------------------------------------------------------------------------------------

const proxyPassword = "go-client-must-not-show-this-password"

func TestAcquireSendsAProxyATimeZoneALanguageAndNodeLabelsWhenAskedFor(t *testing.T) {
	f := newFakeBox(fakeOptions{modern: true})
	c := newClient(t, f)
	slot, err := c.Acquire(background(), browserbay.AcquireOptions{
		RunID: "run-1", MaxLifetime: 3000 * time.Second,
		Proxy:      &browserbay.ProxyOptions{Server: "http://proxy.example.com:8080", Username: "user", Password: proxyPassword, Bypass: "*.internal.test"},
		Timezone:   "Europe/Berlin",
		Locale:     "de-DE",
		NodeLabels: []string{"home", "eu"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"runId": "run-1", "maxLifetimeSeconds": 3000.0, "waitMs": 30000.0,
		"proxy":    map[string]any{"server": "http://proxy.example.com:8080", "username": "user", "password": proxyPassword, "bypass": "*.internal.test"},
		"timezone": "Europe/Berlin", "locale": "de-DE", "nodeLabels": []any{"home", "eu"},
	}
	if got := f.callLog()[0].Body; asJSON(got) != asJSON(want) {
		t.Errorf("body: %v, want %v", got, want)
	}
	stored, _ := json.Marshal(slot)
	if strings.Contains(string(stored), proxyPassword) {
		t.Errorf("a stored slot carries the proxy password: %s", stored)
	}

	// Only what is asked for is sent: no key for an option left out, and none for an empty list of labels.
	g := newFakeBox(fakeOptions{modern: true})
	if _, err := newClient(t, g).Acquire(background(), browserbay.AcquireOptions{RunID: "run-2", MaxLifetime: 3000 * time.Second, Timezone: "UTC", NodeLabels: []string{}}); err != nil {
		t.Fatal(err)
	}
	if got, want := g.callLog()[0].Body, map[string]any{"runId": "run-2", "maxLifetimeSeconds": 3000.0, "waitMs": 30000.0, "timezone": "UTC"}; asJSON(got) != asJSON(want) {
		t.Errorf("body: %v, want %v", got, want)
	}
}

func TestAcquireWithoutOptionsIsTheRequestABoxHasAlwaysTaken(t *testing.T) {
	f := newFakeBox(fakeOptions{}) // an old box: it says nothing of what it applied
	if _, err := newClient(t, f).Acquire(background(), browserbay.AcquireOptions{RunID: "run-1", MaxLifetime: 3000 * time.Second}); err != nil {
		t.Fatal(err)
	}
	if len(f.slotIDs()) != 1 {
		t.Errorf("slots: %v", f.slotIDs())
	}
}

func TestAcquireOnABoxThatPredatesTheOptionsReleasesTheBrowserAndRefuses(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	_, err := newClient(t, f).Acquire(background(), browserbay.AcquireOptions{
		RunID: "run-1", MaxLifetime: 3000 * time.Second,
		Proxy: &browserbay.ProxyOptions{Server: "http://proxy.example.com:8080", Username: "u", Password: proxyPassword},
	})
	if !errors.Is(err, browserbay.ErrUnsupported) {
		t.Fatalf("err = %v, want ErrUnsupported", err)
	}
	if !strings.Contains(err.Error(), "did not apply proxy") || !strings.Contains(err.Error(), "older") || strings.Contains(err.Error(), proxyPassword) {
		t.Errorf("message: %q", err)
	}
	var apiErr *browserbay.Error
	if !errors.As(err, &apiErr) || apiErr.Code != "unsupported" {
		t.Errorf("error: %#v", apiErr)
	}
	methods := []string{}
	for _, c := range f.callLog() {
		methods = append(methods, c.Method)
	}
	if strings.Join(methods, " ") != "POST DELETE" {
		t.Errorf("calls: %v, want the browser made without the proxy to be released", methods)
	}
	if len(f.slotIDs()) != 0 {
		t.Errorf("slots left: %v", f.slotIDs())
	}
}

func TestAcquireOnABoxThatAppliedOnlySomeIsRefusedTooAndSaysWhich(t *testing.T) {
	f := newFakeBox(fakeOptions{createBody: `{"slotId":"slot-9","token":"t","nodeId":"n","applied":["timezone"]}`})
	_, err := newClient(t, f).Acquire(background(), browserbay.AcquireOptions{
		RunID: "run-1", MaxLifetime: 3000 * time.Second,
		Proxy: &browserbay.ProxyOptions{Server: "http://p.example:1"}, Timezone: "UTC", Locale: "fr",
	})
	if !errors.Is(err, browserbay.ErrUnsupported) || !strings.Contains(err.Error(), "did not apply proxy, locale") {
		t.Fatalf("err = %v", err)
	}
	calls := f.callLog()
	if len(calls) != 2 || calls[1].Method != "DELETE" || calls[1].Path != "/v1/slots/slot-9" {
		t.Errorf("calls: %+v", calls)
	}
}

func TestAcquireWhenTheBrowserCannotBeReleasedSaysSoAndStillRefuses(t *testing.T) {
	var warned []string
	f := newFakeBox(fakeOptions{deleteStatus: func(string) int { return 500 }})
	c := newClient(t, f, with(func(o *browserbay.Options) {
		o.Logger = browserbay.LoggerFunc(func(message string, fields map[string]any) { warned = append(warned, message+fmt.Sprint(fields)) })
	})...)
	_, err := c.Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: 3000 * time.Second, Proxy: &browserbay.ProxyOptions{Server: "http://p.example:1", Username: "u", Password: proxyPassword}})
	if !errors.Is(err, browserbay.ErrUnsupported) {
		t.Fatalf("err = %v", err)
	}
	if len(warned) != 1 || strings.Contains(warned[0], proxyPassword) {
		t.Errorf("warnings: %v", warned)
	}
}

func TestAcquire422IsUnsupportedWithTheBoxsReasonAnd400SaysWhatWasWrong(t *testing.T) {
	f := newFakeBox(fakeOptions{createStatus: 422, createBody: `{"error":"unsupported","message":"No node offers proxy"}`})
	_, err := newClient(t, f).Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: 3000 * time.Second, Proxy: &browserbay.ProxyOptions{Server: "http://p.example:1", Username: "u", Password: proxyPassword}})
	var apiErr *browserbay.Error
	if !errors.Is(err, browserbay.ErrUnsupported) || !errors.As(err, &apiErr) || apiErr.Status != 422 || !strings.Contains(err.Error(), "No node offers proxy") || strings.Contains(err.Error(), proxyPassword) {
		t.Errorf("err = %v (%+v)", err, apiErr)
	}
	if len(f.callLog()) != 1 {
		t.Errorf("nothing was made, so nothing is released: %d calls", len(f.callLog()))
	}

	g := newFakeBox(fakeOptions{createStatus: 400, createBody: `{"error":"invalid_request","message":"proxy.server must be http://host:port"}`})
	_, err = newClient(t, g).Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: 3000 * time.Second, Proxy: &browserbay.ProxyOptions{Server: "nope"}})
	if errors.Is(err, browserbay.ErrUnsupported) || !errors.As(err, &apiErr) || apiErr.Status != 400 || apiErr.Code != "invalid_request" || !strings.Contains(err.Error(), "proxy.server must be") {
		t.Errorf("err = %v (%+v)", err, apiErr)
	}
	// A 400 with no message (an older box) is still a plain refusal.
	h := newFakeBox(fakeOptions{createStatus: 400})
	_, err = newClient(t, h).Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: 3000 * time.Second})
	if err == nil || !strings.HasSuffix(err.Error(), "refused the request (400)") {
		t.Errorf("err = %v", err)
	}
}

func TestAcquireRefusesAProxyWithoutAServerBeforeSendingAnything(t *testing.T) {
	f := newFakeBox(fakeOptions{modern: true})
	_, err := newClient(t, f).Acquire(background(), browserbay.AcquireOptions{RunID: "r", MaxLifetime: 3000 * time.Second, Proxy: &browserbay.ProxyOptions{Username: "u"}})
	if !errors.Is(err, browserbay.ErrInvalidArgument) || len(f.callLog()) != 0 {
		t.Errorf("err = %v, calls = %d", err, len(f.callLog()))
	}
}

func TestAProxyHidesItsPasswordWhateverWayItIsPrinted(t *testing.T) {
	p := browserbay.ProxyOptions{Server: "http://proxy.example.com:8080", Username: "user", Password: proxyPassword}
	for _, shown := range []string{
		fmt.Sprint(p), fmt.Sprintf("%v", p), fmt.Sprintf("%+v", p), fmt.Sprintf("%#v", p), p.String(),
		fmt.Sprint(&p), fmt.Sprintf("%v", []browserbay.ProxyOptions{p}), fmt.Sprintf("%+v", browserbay.AcquireOptions{Proxy: &p}),
	} {
		if strings.Contains(shown, proxyPassword) {
			t.Errorf("a printed proxy shows its password: %s", shown)
		}
	}
	if !strings.Contains(p.String(), `Password: "***"`) || !strings.Contains((&browserbay.ProxyOptions{Server: "x"}).String(), `Password: ""`) {
		t.Errorf("redaction: %s", p.String())
	}
}

func TestNodesSayWhatTheyCanDoWhatTheyAreCalledAndWhetherTheyAreKeptForTheirLabels(t *testing.T) {
	f := newFakeBox(fakeOptions{})
	f.nodesBody = `{"nodes":[{"nodeId":"home","maxContexts":2,"features":["proxy","locale"],"labels":["home"],"exclusive":true},{"nodeId":"old","maxContexts":2}]}`
	nodes, err := newClient(t, f).Nodes(background())
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || strings.Join(nodes[0].Features, ",") != "proxy,locale" || strings.Join(nodes[0].Labels, ",") != "home" || !nodes[0].Exclusive {
		t.Errorf("home: %+v", nodes)
	}
	if len(nodes[1].Features) != 0 || len(nodes[1].Labels) != 0 || nodes[1].Exclusive {
		t.Errorf("a box that predates them sends none: %+v", nodes[1])
	}
}

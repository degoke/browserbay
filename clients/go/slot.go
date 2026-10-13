package browserbay

import (
	"context"
	"encoding/json"
	"net/http"
)

// StoredSlot is the part of a slot worth keeping to come back to it later with [Client.Slot]. It contains the slot
// token: store it like a secret. Its JSON form is the wire form used by every browserbay client.
type StoredSlot struct {
	SlotID string `json:"slotId"`
	Token  string `json:"token"`
	// URL is the box the slot is on. Empty means the client's own box.
	URL    string `json:"url,omitempty"`
	NodeID string `json:"nodeId,omitempty"`
}

// Slot is one isolated browser (a browser context on whichever node had room) and how to reach it. Get one from
// [Client.Acquire] or [Client.Slot]. Treat it as read-only.
//
// json.Marshal of a Slot gives its [StoredSlot] form, so it round-trips through [Client.Slot].
type Slot struct {
	// URL is the box the slot lives on, without a trailing slash.
	URL string
	// SlotID identifies the slot on its box.
	SlotID string
	// NodeID is the node that runs the browser. It can be empty for a slot rebuilt from a stored one that lacked it.
	NodeID string
	// Token reaches this slot's browser and nothing else. Treat it as a secret.
	Token string
	// CDPURL is the DevTools endpoint (ws:// or wss://) to hand to a CDP client, together with [Slot.Headers].
	CDPURL string

	client *Client
}

// Headers returns the headers every DevTools connection to this slot must carry. A fresh value each call, so a
// caller cannot change what the next one sees. The key is in canonical form (X-Browserbay-Token); HTTP and
// WebSocket headers are case-insensitive. [TokenHeader] is the lower-case name for libraries that take a plain map.
func (s Slot) Headers() http.Header {
	h := http.Header{}
	h.Set(TokenHeader, s.Token)
	return h
}

// IsAlive reports whether the slot's browser is reachable. It never fails: a box that cannot be asked counts as
// "not alive". It asks the box with the slot's own token, and once more after a short pause when the box could not
// be reached or answered with a server error. A 404 or 401 is final.
//
// After a relay restart, nodes take up to about 15 seconds to reconnect and the box can say false for a slot that
// is about to come back.
func (s Slot) IsAlive(ctx context.Context) bool {
	if s.client == nil {
		return false
	}
	return s.client.lookup(ctx, s.URL, s.SlotID, s.Token)
}

// Release closes the browser. It is safe to call for one that is already gone, and again after a release.
func (s Slot) Release(ctx context.Context) error {
	if s.client == nil {
		return invalid("this Slot was not made by a Client")
	}
	return s.client.deleteSlot(ctx, s.URL, s.SlotID)
}

// Stored returns the [StoredSlot] for this slot: what to persist to come back to it with [Client.Slot].
func (s Slot) Stored() StoredSlot {
	return StoredSlot{SlotID: s.SlotID, Token: s.Token, URL: s.URL, NodeID: s.NodeID}
}

// MarshalJSON gives the stored form: slotId, token, url and nodeId, and never the API key.
func (s Slot) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.Stored())
}

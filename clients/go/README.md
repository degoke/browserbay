# browserbay for Go

A Go client for [browserbay](../../README.md): a self-hosted box that lends out isolated Chromium browsers. Ask the box for a slot, get a DevTools WebSocket address and a token, and drive the browser with any CDP library.

Standard library only, Go 1.22 or newer.

## Install

```sh
go get github.com/degoke/browserbay/clients/go
```

The module lives in a subdirectory of the repository (`clients/go`), so its versions are tagged `clients/go/vX.Y.Z`, not `vX.Y.Z`. The repository's own `v0.2.1` is the Node package's tag, and `go get github.com/degoke/browserbay/clients/go@v0.2.1` fails with "does not contain package". Until a `clients/go` tag is pushed, `go get` takes the latest commit on `main` as a pseudo-version (`v0.0.0-<date>-<commit>`). Pin one with `go get github.com/degoke/browserbay/clients/go@<commit>`. Once there is a tag, `@vX.Y.Z` resolves `clients/go/vX.Y.Z`.

## Quick start

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	browserbay "github.com/degoke/browserbay/clients/go"
)

func main() {
	ctx := context.Background()

	box, err := browserbay.New(browserbay.Options{
		URL:    "https://browsers.example.com",
		APIKey: os.Getenv("BROWSERBAY_API_KEY"),
	})
	if err != nil {
		log.Fatal(err)
	}

	slot, err := box.Acquire(ctx, browserbay.AcquireOptions{
		RunID:       "task-42",        // your own id for what the browser is for
		MaxLifetime: 30 * time.Minute, // the box closes the browser after this, connected or not
	})
	if errors.Is(err, browserbay.ErrNoCapacity) {
		log.Fatal("every browser is busy, try again later")
	} else if err != nil {
		log.Fatal(err)
	}
	defer slot.Release(ctx) // idempotent

	fmt.Println(slot.CDPURL)    // wss://browsers.example.com/v1/cdp/<slotId>
	fmt.Println(slot.Headers()) // the headers the connection must carry
}
```

## Connect with playwright-go

Hand the slot's address and its headers to `ConnectOverCDP`. This is a code sample only: `playwright-go` is not a dependency of this module.

```go
pw, err := playwright.Run()
if err != nil {
	log.Fatal(err)
}
defer pw.Stop()

browser, err := pw.Chromium.ConnectOverCDP(slot.CDPURL, playwright.BrowserTypeConnectOverCDPOptions{
	Headers: map[string]string{browserbay.TokenHeader: slot.Token},
})
if err != nil {
	log.Fatal(err)
}
defer browser.Close()

page, err := browser.Contexts()[0].NewPage() // the slot's own browser context
if err != nil {
	log.Fatal(err)
}
if _, err := page.Goto("https://example.com"); err != nil {
	log.Fatal(err)
}
```

## Raw WebSocket

The slot's endpoint is a plain WebSocket speaking the DevTools protocol. Whatever connects must send the slot token in the `x-browserbay-token` header. `slot.Headers()` returns an `http.Header` carrying it (a fresh one on every call), which is what libraries such as gorilla/websocket take:

```go
conn, _, err := websocket.DefaultDialer.DialContext(ctx, slot.CDPURL, slot.Headers())
```

## What the client does

| Call                                   | Does                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `box.Acquire(ctx, opts)`               | Takes a browser. `ErrNoCapacity` when the box stays full for the whole `Wait` (default 30 s).            |
| `box.Slot(stored)`                     | A slot from what you saved earlier. Makes no request.                                                    |
| `box.Release(ctx, slotID)`             | Releases a slot you only know the id of. `box.ReleaseAt(ctx, boxURL, slotID)` for one on another box.    |
| `box.List(ctx)`                        | Slots (this namespace's, if you set one), with their run ids.                                            |
| `box.Nodes(ctx)`                       | Nodes and their load.                                                                                    |
| `box.Reap(ctx, opts)`                  | Releases slots whose run `IsLive` says is gone; returns how many. Young slots (`Grace`, 3 min) are kept. |
| `slot.IsAlive(ctx)`                    | Never fails: asks twice, and a box that cannot be asked counts as "not alive".                           |
| `slot.Release(ctx)`                    | Closes the browser. Idempotent.                                                                          |
| `json.Marshal(slot)` / `slot.Stored()` | What to save to come back to the browser later. It holds the slot token: store it like a secret.         |

Zero values mean "the default". To ask for the opposite use `browserbay.NoWait` (do not wait for a free slot), `browserbay.NoGrace` (reap slots of any age) and `browserbay.NoRetryDelay`.

**Reconnecting.** Save `json.Marshal(slot)`, later unmarshal it into a `browserbay.StoredSlot`, call `box.Slot(stored)`, check `IsAlive`, and reconnect: the same pages are still there.

**Credentials stay with their box.** The API key and slot tokens are only sent to the box the client was made for. A stored slot that names another box is refused with `ErrUntrustedBox` unless you list that box in `Options.AllowOtherBoxes` (addresses are compared however they are spelled), or set `AllowAnyBox` for storage nobody else can write. The default HTTP client also refuses redirects to another host.

**Namespaces.** Give each project sharing a box a `Namespace`: slots are created as `<namespace>:<runId>`, and `List` and `Reap` only see that project's. It is a naming convention, not access control.

**Errors.** `errors.Is(err, browserbay.ErrNoCapacity)` for a full box, `ErrQuotaExceeded` when the API key's quota is used up (answered at once, without waiting), `ErrForbidden` when the key is confined to another namespace (make the client with the matching `Namespace`), `ErrInvalidArgument` for options refused before anything was sent, `ErrUntrustedBox`, and `errors.As(err, &apiErr)` with `var apiErr *browserbay.Error` for the HTTP status of anything else the box answered.

Every network call takes a `context.Context`; cancel it to stop waiting.

## License

This client is released under the [MIT license](LICENSE), like the rest of browserbay.

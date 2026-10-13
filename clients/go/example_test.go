package browserbay_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	browserbay "github.com/degoke/browserbay/clients/go"
)

func Example() {
	ctx := context.Background()
	box, err := browserbay.New(browserbay.Options{
		URL:    "https://browsers.example.com",
		APIKey: os.Getenv("BROWSERBAY_API_KEY"),
	})
	if err != nil {
		log.Fatal(err)
	}
	slot, err := box.Acquire(ctx, browserbay.AcquireOptions{RunID: "task-42", MaxLifetime: 30 * time.Minute})
	if errors.Is(err, browserbay.ErrNoCapacity) {
		log.Fatal("every browser is busy, try again later")
	} else if err != nil {
		log.Fatal(err)
	}
	defer slot.Release(ctx)

	// Hand slot.CDPURL and slot.Headers() to your CDP library.
	fmt.Println(slot.CDPURL)
}

func ExampleClient_Slot() {
	ctx := context.Background()
	box, _ := browserbay.New(browserbay.Options{URL: "https://browsers.example.com", APIKey: os.Getenv("BROWSERBAY_API_KEY")})

	// Save a slot (it holds the slot token: store it like a secret) ...
	slot, _ := box.Acquire(ctx, browserbay.AcquireOptions{RunID: "task-42", MaxLifetime: time.Hour})
	saved, _ := json.Marshal(slot)

	// ... and come back to it later, from another process. This makes no request.
	var stored browserbay.StoredSlot
	_ = json.Unmarshal(saved, &stored)
	again, err := box.Slot(stored)
	if err != nil {
		log.Fatal(err)
	}
	if again.IsAlive(ctx) {
		fmt.Println("still there:", again.CDPURL)
	}
}

func ExampleClient_Reap() {
	box, _ := browserbay.New(browserbay.Options{
		URL: "https://browsers.example.com", APIKey: os.Getenv("BROWSERBAY_API_KEY"), Namespace: "billing",
	})
	released, err := box.Reap(context.Background(), browserbay.ReapOptions{
		// Is the job this browser was taken for still running?
		IsLive: func(ctx context.Context, runID string) (bool, error) { return false, nil },
	})
	fmt.Println(released, err)
}

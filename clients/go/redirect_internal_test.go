package browserbay

import (
	"net/http"
	"strings"
	"testing"
)

// The default client's redirect rule, checked directly: a hop within the same host is only safe if it does not leave
// https, because Go forwards the API key and the slot token on it whatever the scheme.
func TestDefaultHTTPClientRedirectRule(t *testing.T) {
	request := func(url string) *http.Request {
		r, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	check := defaultHTTPClient().CheckRedirect
	httpsFirst := []*http.Request{request("https://browsers.example.com/v1/slots")}
	httpFirst := []*http.Request{request("http://browsers.example.com/v1/slots")}

	for _, tc := range []struct {
		name    string
		next    string
		via     []*http.Request
		refused string // empty: followed
	}{
		{"same host and scheme", "https://browsers.example.com/elsewhere", httpsFirst, ""},
		{"https to plain http on the same host", "http://browsers.example.com/v1/slots", httpsFirst, "https to plain http"},
		{"another host", "https://other.example.com/v1/slots", httpsFirst, "another host"},
		{"another port", "https://browsers.example.com:8443/v1/slots", httpsFirst, "another host"},
		{"plain http to https is an upgrade, not a downgrade", "https://browsers.example.com/v1/slots", httpFirst, ""},
	} {
		err := check(request(tc.next), tc.via)
		switch {
		case tc.refused == "" && err != nil:
			t.Errorf("%s: followed, got %v", tc.name, err)
		case tc.refused != "" && (err == nil || !strings.Contains(err.Error(), tc.refused)):
			t.Errorf("%s: want a refusal mentioning %q, got %v", tc.name, tc.refused, err)
		}
	}
}

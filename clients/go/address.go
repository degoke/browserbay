package browserbay

import (
	"net/url"
	"strings"
)

// parseBoxURL checks a box address and returns it without trailing slashes. A path prefix is kept.
func parseBoxURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", invalid("the browserbay URL is not a URL: %q", value)
	}
	if s := strings.ToLower(u.Scheme); s != "http" && s != "https" {
		return "", invalid("the browserbay URL must be http(s)://, e.g. https://browsers.example.com")
	}
	if u.User != nil {
		return "", invalid("the browserbay URL must not contain credentials; pass the API key as APIKey")
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", invalid("the browserbay URL must not have a query or a fragment: %q", value)
	}
	return strings.TrimRight(value, "/"), nil
}

// canonicalBox is the same address however it is spelled: scheme and host in lower case, a default port dropped, dot
// segments resolved and no trailing slash. The argument must have passed parseBoxURL.
func canonicalBox(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return value
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		host += ":" + port
	}
	// Resolving an empty reference against the address removes any "." and ".." segments from its path.
	path := strings.TrimRight(u.ResolveReference(&url.URL{}).EscapedPath(), "/")
	return scheme + "://" + host + path
}

// originOf is the scheme and host of an address, for messages that must not repeat a whole path.
func originOf(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return value
	}
	return strings.ToLower(u.Scheme) + "://" + u.Host
}

// cdpURLFor is the box's CDP socket for a slot: the box's own address with the scheme swapped and any path prefix kept.
func cdpURLFor(boxURL, slotID string) string {
	canonical := canonicalBox(boxURL)
	switch {
	case strings.HasPrefix(canonical, "https://"):
		canonical = "wss://" + strings.TrimPrefix(canonical, "https://")
	case strings.HasPrefix(canonical, "http://"):
		canonical = "ws://" + strings.TrimPrefix(canonical, "http://")
	}
	return canonical + "/v1/cdp/" + url.PathEscape(slotID)
}

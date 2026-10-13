package browserbay

import (
	"errors"
	"fmt"
	"regexp"
)

var (
	// ErrNoCapacity is what [Client.Acquire] fails with when the box stays full for the whole wait: every node is at
	// its limit, or none is connected. Test for it with errors.Is; the error also unwraps to an *[Error] with Status 503.
	ErrNoCapacity = errors.New("no browser capacity is available right now")

	// ErrForbidden is what [Client.Acquire] fails with when the API key may not use this run id: it is confined to a
	// namespace on the box, and the client was not made with the matching [Options.Namespace]. A confined key also
	// cannot list nodes. Test for it with errors.Is; the error also unwraps to an *[Error] with Status 403.
	ErrForbidden = errors.New("the API key is not allowed to do this")

	// ErrQuotaExceeded is what [Client.Acquire] fails with when the API key's namespace already holds as many browsers
	// as its quota allows. Unlike [ErrNoCapacity] it is answered at once: the box does not wait for a slot to free up.
	// Test for it with errors.Is; the error also unwraps to an *[Error] with Status 429.
	ErrQuotaExceeded = errors.New("this API key's quota of browsers is used up")

	// ErrInvalidArgument marks a call refused before anything was sent, because an option is one the box would
	// refuse (a run id that is too long, a lifetime out of range) or an address that is not usable.
	ErrInvalidArgument = errors.New("invalid argument")

	// ErrUntrustedBox marks a stored slot (or a release) that names a box other than the one this client was made
	// for and that is not listed in [Options.AllowOtherBoxes]. Nothing was sent to it: the API key and the slot
	// token only ever go to boxes the client has been told to trust.
	ErrUntrustedBox = errors.New("untrusted box")
)

// Error is a failure the box itself reported, or an answer from it that the client cannot use. It never contains
// the API key or a slot token. Recover it with errors.As:
//
//	var apiErr *browserbay.Error
//	if errors.As(err, &apiErr) { log.Println(apiErr.Status) }
type Error struct {
	// Status is the HTTP status the box answered with.
	Status int
	// Code is the box's own error code (for example "no_capacity" or "unauthorized"), when it sent a recognisable one.
	Code string
	// Message describes what failed, without secrets.
	Message string

	cause error
}

// Error implements the error interface.
func (e *Error) Error() string { return "browserbay: " + e.Message }

// Unwrap returns the sentinel this error stands for ([ErrNoCapacity]), if any.
func (e *Error) Unwrap() error { return e.cause }

func newError(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

func noCapacity() *Error {
	return &Error{
		Status:  503,
		Code:    "no_capacity",
		Message: ErrNoCapacity.Error(),
		cause:   ErrNoCapacity,
	}
}

func forbidden() *Error {
	return &Error{
		Status: 403,
		Code:   "forbidden",
		Message: "the API key is not allowed to do this. A key confined to a namespace can only use run ids in it " +
			"(set the client's Namespace to match) and cannot list nodes",
		cause: ErrForbidden,
	}
}

func quotaExceeded() *Error {
	return &Error{Status: 429, Code: "quota_exceeded", Message: ErrQuotaExceeded.Error(), cause: ErrQuotaExceeded}
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("browserbay: %w: %s", ErrInvalidArgument, fmt.Sprintf(format, args...))
}

var errorCodePattern = regexp.MustCompile(`^[a-z_]{1,40}$`)

package util

import "strings"

func EscapePathParamValue(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == '%' && i+2 < len(value) && isHexDigit(value[i+1]) && isHexDigit(value[i+2]) {
			out.WriteByte(c)
			continue
		}
		if pathParamSafeByte(c) {
			out.WriteByte(c)
			continue
		}
		out.WriteByte('%')
		out.WriteByte("0123456789ABCDEF"[c>>4])
		out.WriteByte("0123456789ABCDEF"[c&15])
	}
	return out.String()
}

func pathParamSafeByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("-._~!$&'()*+,;=:@{}", c) >= 0
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

package api

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"time"
)

func randInt(min, max int64) int64 {
	if max <= min {
		return min
	}
	n, err := rand.Int(rand.Reader, big.NewInt(max-min+1))
	if err != nil {
		return min
	}
	return min + n.Int64()
}

func pick(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[randInt(0, int64(len(values)-1))]
}

func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func hexString(length int) string {
	const digits = "0123456789abcdef"
	var out strings.Builder
	for i := 0; i < length; i++ {
		out.WriteByte(digits[randInt(0, 15)])
	}
	return out.String()
}

func alphaNumeric() string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	return string(chars[randInt(0, int64(len(chars)-1))])
}

func offsetDate(ms int64) string {
	return time.Now().Add(time.Duration(ms) * time.Millisecond).UTC().Format(time.RFC3339)
}

var (
	dvFirstNames      = []string{"Ada", "Grace", "Alan", "Linus", "Barbara", "Dennis", "Radia", "Ken", "Margaret", "Edsger", "Katherine", "Tim"}
	dvLastNames       = []string{"Lovelace", "Hopper", "Turing", "Torvalds", "Liskov", "Ritchie", "Perlman", "Thompson", "Hamilton", "Dijkstra", "Johnson", "Berners-Lee"}
	dvCities          = []string{"Lisbon", "Osaka", "Nairobi", "Toronto", "Helsinki", "Bogota", "Warsaw", "Auckland", "Reykjavik", "Seoul"}
	dvCountries       = []string{"Portugal", "Japan", "Kenya", "Canada", "Finland", "Colombia", "Poland", "New Zealand", "Iceland", "South Korea"}
	dvCountryCodes    = []string{"PT", "JP", "KE", "CA", "FI", "CO", "PL", "NZ", "IS", "KR"}
	dvStreets         = []string{"Maple Street", "Harbour Road", "Rua das Flores", "Station Avenue", "Kings Way", "Cedar Lane"}
	dvCompanyPrefixes = []string{"North", "Bright", "Iron", "Quantum", "Cedar", "Atlas", "Nimbus", "Vertex"}
	dvCompanySuffixes = []string{"Labs", "Systems", "Works", "Industries", "Group", "Collective"}
	dvJobTitles       = []string{"Backend Engineer", "Product Designer", "Data Analyst", "Site Reliability Engineer", "Support Lead", "QA Engineer"}
	dvWords           = []string{"orbit", "lantern", "harbor", "signal", "ember", "thicket", "meridian", "cobalt", "quarry", "drift", "plateau", "willow"}
	dvColors          = []string{"red", "green", "blue", "cyan", "magenta", "olive", "teal", "indigo", "amber"}
	dvMimeTypes       = []string{"application/json", "text/plain", "text/html", "image/png", "application/pdf", "application/xml"}
	dvFileExtensions  = []string{"json", "txt", "csv", "png", "pdf", "xml", "yaml"}
	dvCurrencyCodes   = []string{"USD", "EUR", "GBP", "JPY", "CHF", "SEK", "CAD"}
	dvCurrencyNames   = []string{"US Dollar", "Euro", "Pound Sterling", "Yen", "Swiss Franc", "Swedish Krona", "Canadian Dollar"}
	dvCurrencySymbols = []string{"$", "€", "£", "¥", "CHF", "kr", "C$"}
	dvUserAgents      = []string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
		"Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
	}
)

func dvSentence() string {
	length := randInt(5, 10)
	words := make([]string, 0, length)
	for i := int64(0); i < length; i++ {
		words = append(words, pick(dvWords))
	}
	first := words[0]
	words[0] = strings.ToUpper(first[:1]) + first[1:]
	return strings.Join(words, " ") + "."
}

func dvDomainWord() string {
	return pick(dvWords) + pick(dvWords)
}

func dvUserName() string {
	last := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			return r
		}
		return -1
	}, strings.ToLower(pick(dvLastNames)))
	return strings.ToLower(pick(dvFirstNames)) + "." + last
}

var dynamicGenerators = map[string]func() string{
	"$guid":               randomUUID,
	"$randomUUID":         randomUUID,
	"$timestamp":          func() string { return fmt.Sprintf("%d", time.Now().Unix()) },
	"$isoTimestamp":       func() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") },
	"$randomInt":          func() string { return fmt.Sprintf("%d", randInt(0, 1000)) },
	"$randomBoolean":      func() string { return map[bool]string{true: "true", false: "false"}[randInt(0, 1) == 1] },
	"$randomAlphaNumeric": alphaNumeric,
	"$randomFirstName":    func() string { return pick(dvFirstNames) },
	"$randomLastName":     func() string { return pick(dvLastNames) },
	"$randomFullName":     func() string { return pick(dvFirstNames) + " " + pick(dvLastNames) },
	"$randomUserName":     dvUserName,
	"$randomEmail":        func() string { return dvUserName() + "@" + dvDomainWord() + ".com" },
	"$randomExampleEmail": func() string { return dvUserName() + "@example.com" },
	"$randomPhoneNumber": func() string {
		return fmt.Sprintf("%d-%d-%04d", randInt(200, 999), randInt(200, 999), randInt(0, 9999))
	},
	"$randomIP": func() string {
		return fmt.Sprintf("%d.%d.%d.%d", randInt(1, 254), randInt(1, 254), randInt(1, 254), randInt(1, 254))
	},
	"$randomIPV6": func() string {
		return strings.Join([]string{hexString(4), hexString(4), hexString(4), hexString(4), hexString(4), hexString(4), hexString(4), hexString(4)}, ":")
	},
	"$randomMACAddress": func() string {
		return strings.Join([]string{hexString(2), hexString(2), hexString(2), hexString(2), hexString(2), hexString(2)}, ":")
	},
	"$randomDomainName": func() string { return dvDomainWord() + ".com" },
	"$randomDomainWord": dvDomainWord,
	"$randomUrl":        func() string { return "https://" + dvDomainWord() + ".com/" + pick(dvWords) },
	"$randomProtocol":   func() string { return pick([]string{"http", "https"}) },
	"$randomPort":       func() string { return fmt.Sprintf("%d", randInt(1024, 65535)) },
	"$randomPassword": func() string {
		var b strings.Builder
		for i := 0; i < 15; i++ {
			b.WriteString(alphaNumeric())
		}
		return b.String()
	},
	"$randomColor":         func() string { return pick(dvColors) },
	"$randomHexColor":      func() string { return "#" + hexString(6) },
	"$randomCity":          func() string { return pick(dvCities) },
	"$randomCountry":       func() string { return pick(dvCountries) },
	"$randomCountryCode":   func() string { return pick(dvCountryCodes) },
	"$randomStreetAddress": func() string { return fmt.Sprintf("%d %s", randInt(1, 999), pick(dvStreets)) },
	"$randomLatitude":      func() string { return fmt.Sprintf("%.6f", float64(randInt(-9000000, 9000000))/100000) },
	"$randomLongitude":     func() string { return fmt.Sprintf("%.6f", float64(randInt(-18000000, 18000000))/100000) },
	"$randomCompanyName":   func() string { return pick(dvCompanyPrefixes) + " " + pick(dvCompanySuffixes) },
	"$randomJobTitle":      func() string { return pick(dvJobTitles) },
	"$randomWord":          func() string { return pick(dvWords) },
	"$randomWords": func() string {
		n := randInt(2, 5)
		words := make([]string, 0, n)
		for i := int64(0); i < n; i++ {
			words = append(words, pick(dvWords))
		}
		return strings.Join(words, " ")
	},
	"$randomLoremSentence": dvSentence,
	"$randomLoremParagraph": func() string {
		n := randInt(3, 5)
		parts := make([]string, 0, n)
		for i := int64(0); i < n; i++ {
			parts = append(parts, dvSentence())
		}
		return strings.Join(parts, " ")
	},
	"$randomDatePast":       func() string { return offsetDate(-randInt(1, 365) * 86_400_000) },
	"$randomDateFuture":     func() string { return offsetDate(randInt(1, 365) * 86_400_000) },
	"$randomDateRecent":     func() string { return offsetDate(-randInt(1, 7) * 86_400_000) },
	"$randomBankAccount":    func() string { return fmt.Sprintf("%d", randInt(10_000_000, 99_999_999)) },
	"$randomCreditCardMask": func() string { return fmt.Sprintf("%d", randInt(1000, 9999)) },
	"$randomCurrencyCode":   func() string { return pick(dvCurrencyCodes) },
	"$randomCurrencyName":   func() string { return pick(dvCurrencyNames) },
	"$randomCurrencySymbol": func() string { return pick(dvCurrencySymbols) },
	"$randomPrice":          func() string { return fmt.Sprintf("%d.%02d", randInt(1, 999), randInt(0, 99)) },
	"$randomMimeType":       func() string { return pick(dvMimeTypes) },
	"$randomFileExt":        func() string { return pick(dvFileExtensions) },
	"$randomFileName":       func() string { return pick(dvWords) + "_" + pick(dvWords) + "." + pick(dvFileExtensions) },
	"$randomSemver":         func() string { return fmt.Sprintf("%d.%d.%d", randInt(0, 9), randInt(0, 20), randInt(0, 20)) },
	"$randomUserAgent":      func() string { return pick(dvUserAgents) },
}

func resolveDynamicCLIVariable(name string) (string, bool) {
	if gen, ok := dynamicGenerators[name]; ok {
		return gen(), true
	}
	return "", false
}

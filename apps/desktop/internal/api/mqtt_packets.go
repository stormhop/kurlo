package api

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	mqttConnect     byte = 1
	mqttConnack     byte = 2
	mqttPublish     byte = 3
	mqttPuback      byte = 4
	mqttPubrec      byte = 5
	mqttPubrel      byte = 6
	mqttPubcomp     byte = 7
	mqttSubscribe   byte = 8
	mqttSuback      byte = 9
	mqttUnsubscribe byte = 10
	mqttUnsuback    byte = 11
	mqttPingreq     byte = 12
	mqttPingresp    byte = 13
	mqttDisconnect  byte = 14
	mqttAuth        byte = 15
)

const (
	mqttPropPayloadFormat     byte = 0x01
	mqttPropMessageExpiry     byte = 0x02
	mqttPropContentType       byte = 0x03
	mqttPropResponseTopic     byte = 0x08
	mqttPropCorrelationData   byte = 0x09
	mqttPropSubscriptionID    byte = 0x0B
	mqttPropSessionExpiry     byte = 0x11
	mqttPropAssignedClientID  byte = 0x12
	mqttPropServerKeepAlive   byte = 0x13
	mqttPropAuthMethod        byte = 0x15
	mqttPropAuthData          byte = 0x16
	mqttPropRequestProblem    byte = 0x17
	mqttPropWillDelay         byte = 0x18
	mqttPropRequestResponse   byte = 0x19
	mqttPropResponseInfo      byte = 0x1A
	mqttPropServerReference   byte = 0x1C
	mqttPropReasonString      byte = 0x1F
	mqttPropReceiveMaximum    byte = 0x21
	mqttPropTopicAliasMaximum byte = 0x22
	mqttPropTopicAlias        byte = 0x23
	mqttPropMaximumQoS        byte = 0x24
	mqttPropRetainAvailable   byte = 0x25
	mqttPropUserProperty      byte = 0x26
	mqttPropMaximumPacketSize byte = 0x27
	mqttPropWildcardAvailable byte = 0x28
	mqttPropSubIDAvailable    byte = 0x29
	mqttPropSharedAvailable   byte = 0x2A
)

type mqttPropKind int

const (
	mqttPropByte mqttPropKind = iota
	mqttPropUint16
	mqttPropUint32
	mqttPropVarint
	mqttPropString
	mqttPropBinary
	mqttPropPair
)

var mqttPropKinds = map[byte]mqttPropKind{
	mqttPropPayloadFormat: mqttPropByte, mqttPropMessageExpiry: mqttPropUint32, mqttPropContentType: mqttPropString,
	mqttPropResponseTopic: mqttPropString, mqttPropCorrelationData: mqttPropBinary, mqttPropSubscriptionID: mqttPropVarint,
	mqttPropSessionExpiry: mqttPropUint32, mqttPropAssignedClientID: mqttPropString, mqttPropServerKeepAlive: mqttPropUint16,
	mqttPropAuthMethod: mqttPropString, mqttPropAuthData: mqttPropBinary, mqttPropRequestProblem: mqttPropByte,
	mqttPropWillDelay: mqttPropUint32, mqttPropRequestResponse: mqttPropByte, mqttPropResponseInfo: mqttPropString,
	mqttPropServerReference: mqttPropString, mqttPropReasonString: mqttPropString, mqttPropReceiveMaximum: mqttPropUint16,
	mqttPropTopicAliasMaximum: mqttPropUint16, mqttPropTopicAlias: mqttPropUint16, mqttPropMaximumQoS: mqttPropByte,
	mqttPropRetainAvailable: mqttPropByte, mqttPropUserProperty: mqttPropPair, mqttPropMaximumPacketSize: mqttPropUint32,
	mqttPropWildcardAvailable: mqttPropByte, mqttPropSubIDAvailable: mqttPropByte, mqttPropSharedAvailable: mqttPropByte,
}

type mqttProp struct {
	ID    byte
	Num   uint32
	Str   string
	Bin   []byte
	Value string
}

type mqttProps []mqttProp

func (p mqttProps) num(id byte) (uint32, bool) {
	for _, prop := range p {
		if prop.ID == id {
			return prop.Num, true
		}
	}
	return 0, false
}

func (p mqttProps) str(id byte) string {
	for _, prop := range p {
		if prop.ID == id {
			return prop.Str
		}
	}
	return ""
}

func (p mqttProps) bin(id byte) []byte {
	for _, prop := range p {
		if prop.ID == id {
			return prop.Bin
		}
	}
	return nil
}

func (p mqttProps) pairs() [][2]string {
	var out [][2]string
	for _, prop := range p {
		if prop.ID == mqttPropUserProperty {
			out = append(out, [2]string{prop.Str, prop.Value})
		}
	}
	return out
}

type mqttWriter struct{ buf []byte }

func (w *mqttWriter) byte(b byte) { w.buf = append(w.buf, b) }

func (w *mqttWriter) uint16(v uint16) { w.buf = binary.BigEndian.AppendUint16(w.buf, v) }

func (w *mqttWriter) uint32(v uint32) { w.buf = binary.BigEndian.AppendUint32(w.buf, v) }

func (w *mqttWriter) varint(v uint32) { w.buf = appendMqttVarint(w.buf, v) }

func (w *mqttWriter) binary(b []byte) {
	w.uint16(uint16(len(b)))
	w.buf = append(w.buf, b...)
}

func (w *mqttWriter) string(s string) { w.binary([]byte(s)) }

func (w *mqttWriter) props(props mqttProps) {
	var body mqttWriter
	for _, prop := range props {
		body.byte(prop.ID)
		switch mqttPropKinds[prop.ID] {
		case mqttPropByte:
			body.byte(byte(prop.Num))
		case mqttPropUint16:
			body.uint16(uint16(prop.Num))
		case mqttPropUint32:
			body.uint32(prop.Num)
		case mqttPropVarint:
			body.varint(prop.Num)
		case mqttPropString:
			body.string(prop.Str)
		case mqttPropBinary:
			body.binary(prop.Bin)
		case mqttPropPair:
			body.string(prop.Str)
			body.string(prop.Value)
		}
	}
	w.varint(uint32(len(body.buf)))
	w.buf = append(w.buf, body.buf...)
}

func appendMqttVarint(buf []byte, v uint32) []byte {
	for {
		b := byte(v % 128)
		v /= 128
		if v > 0 {
			b |= 0x80
		}
		buf = append(buf, b)
		if v == 0 {
			return buf
		}
	}
}

func mqttFrame(kind, flags byte, body []byte) []byte {
	out := []byte{kind<<4 | flags&0x0f}
	out = appendMqttVarint(out, uint32(len(body)))
	return append(out, body...)
}

type mqttPacket struct {
	Kind  byte
	Flags byte
	Body  []byte
}

const mqttMaxIncomingPacket = 256 << 20

func readMqttPacket(r *bufio.Reader) (mqttPacket, error) {
	first, err := r.ReadByte()
	if err != nil {
		return mqttPacket{}, err
	}
	var length uint32
	for shift := 0; ; shift += 7 {
		if shift > 21 {
			return mqttPacket{}, errors.New("malformed MQTT packet length")
		}
		b, err := r.ReadByte()
		if err != nil {
			return mqttPacket{}, err
		}
		length |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			break
		}
	}
	if length > mqttMaxIncomingPacket {
		return mqttPacket{}, fmt.Errorf("MQTT packet of %d bytes is too large", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return mqttPacket{}, err
	}
	return mqttPacket{Kind: first >> 4, Flags: first & 0x0f, Body: body}, nil
}

type mqttReader struct {
	buf []byte
	err error
}

var errMqttShort = errors.New("malformed MQTT packet")

func (r *mqttReader) take(n int) []byte {
	if r.err != nil || len(r.buf) < n {
		r.err = errMqttShort
		return nil
	}
	out := r.buf[:n]
	r.buf = r.buf[n:]
	return out
}

func (r *mqttReader) byte() byte {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (r *mqttReader) uint16() uint16 {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint16(b)
}

func (r *mqttReader) uint32() uint32 {
	b := r.take(4)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint32(b)
}

func (r *mqttReader) varint() uint32 {
	var v uint32
	for shift := 0; shift <= 21; shift += 7 {
		b := r.byte()
		v |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return v
		}
	}
	r.err = errMqttShort
	return 0
}

func (r *mqttReader) binary() []byte {
	n := r.uint16()
	return append([]byte(nil), r.take(int(n))...)
}

func (r *mqttReader) string() string { return string(r.binary()) }

func (r *mqttReader) props() mqttProps {
	length := r.varint()
	raw := r.take(int(length))
	if r.err != nil {
		return nil
	}
	inner := &mqttReader{buf: raw}
	var props mqttProps
	for len(inner.buf) > 0 && inner.err == nil {
		id := byte(inner.varint())
		kind, ok := mqttPropKinds[id]
		if !ok {
			r.err = fmt.Errorf("unknown MQTT property 0x%02x", id)
			return props
		}
		prop := mqttProp{ID: id}
		switch kind {
		case mqttPropByte:
			prop.Num = uint32(inner.byte())
		case mqttPropUint16:
			prop.Num = uint32(inner.uint16())
		case mqttPropUint32:
			prop.Num = inner.uint32()
		case mqttPropVarint:
			prop.Num = inner.varint()
		case mqttPropString:
			prop.Str = inner.string()
		case mqttPropBinary:
			prop.Bin = inner.binary()
		case mqttPropPair:
			prop.Str = inner.string()
			prop.Value = inner.string()
		}
		props = append(props, prop)
	}
	if inner.err != nil {
		r.err = inner.err
	}
	return props
}

type mqttConnectPacket struct {
	Version      byte
	ClientID     string
	CleanStart   bool
	KeepAlive    uint16
	Username     string
	Password     string
	HasUsername  bool
	HasPassword  bool
	Props        mqttProps
	Will         *mqttPublishPacket
	WillProps    mqttProps
	ProtocolName string
}

func (c mqttConnectPacket) encode() []byte {
	var w mqttWriter
	name := c.ProtocolName
	if name == "" {
		name = "MQTT"
	}
	w.string(name)
	w.byte(c.Version)
	var flags byte
	if c.HasUsername {
		flags |= 0x80
	}
	if c.HasPassword {
		flags |= 0x40
	}
	if c.Will != nil {
		flags |= 0x04 | byte(c.Will.QoS&3)<<3
		if c.Will.Retain {
			flags |= 0x20
		}
	}
	if c.CleanStart {
		flags |= 0x02
	}
	w.byte(flags)
	w.uint16(c.KeepAlive)
	if c.Version == 5 {
		w.props(c.Props)
	}
	w.string(c.ClientID)
	if c.Will != nil {
		if c.Version == 5 {
			w.props(c.WillProps)
		}
		w.string(c.Will.Topic)
		w.binary(c.Will.Payload)
	}
	if c.HasUsername {
		w.string(c.Username)
	}
	if c.HasPassword {
		w.string(c.Password)
	}
	return mqttFrame(mqttConnect, 0, w.buf)
}

type mqttConnackPacket struct {
	SessionPresent bool
	Code           byte
	Props          mqttProps
}

func decodeMqttConnack(body []byte, version byte) (mqttConnackPacket, error) {
	r := &mqttReader{buf: body}
	out := mqttConnackPacket{SessionPresent: r.byte()&1 == 1, Code: r.byte()}
	if version == 5 && len(r.buf) > 0 {
		out.Props = r.props()
	}
	return out, r.err
}

type mqttPublishPacket struct {
	Topic    string
	Payload  []byte
	QoS      byte
	Retain   bool
	Dup      bool
	PacketID uint16
	Props    mqttProps
}

func (p mqttPublishPacket) encode(version byte) []byte {
	var w mqttWriter
	w.string(p.Topic)
	if p.QoS > 0 {
		w.uint16(p.PacketID)
	}
	if version == 5 {
		w.props(p.Props)
	}
	w.buf = append(w.buf, p.Payload...)
	flags := p.QoS << 1
	if p.Retain {
		flags |= 1
	}
	if p.Dup {
		flags |= 0x08
	}
	return mqttFrame(mqttPublish, flags, w.buf)
}

func decodeMqttPublish(pkt mqttPacket, version byte) (mqttPublishPacket, error) {
	r := &mqttReader{buf: pkt.Body}
	out := mqttPublishPacket{QoS: pkt.Flags >> 1 & 3, Retain: pkt.Flags&1 == 1, Dup: pkt.Flags&0x08 != 0}
	out.Topic = r.string()
	if out.QoS > 0 {
		out.PacketID = r.uint16()
	}
	if version == 5 {
		out.Props = r.props()
	}
	if r.err != nil {
		return out, r.err
	}
	out.Payload = append([]byte(nil), r.buf...)
	return out, nil
}

func mqttAckPacket(kind byte, id uint16, version byte, code byte) []byte {
	var w mqttWriter
	w.uint16(id)
	if version == 5 && code != 0 {
		w.byte(code)
	}
	flags := byte(0)
	if kind == mqttPubrel {
		flags = 2
	}
	return mqttFrame(kind, flags, w.buf)
}

type mqttAck struct {
	ID     uint16
	Codes  []byte
	Reason string
}

func decodeMqttAck(pkt mqttPacket, version byte) (mqttAck, error) {
	r := &mqttReader{buf: pkt.Body}
	ack := mqttAck{ID: r.uint16()}
	multi := pkt.Kind == mqttSuback || pkt.Kind == mqttUnsuback
	if version == 5 {
		if multi || len(r.buf) > 0 {
			if !multi {
				ack.Codes = []byte{r.byte()}
			}
			if len(r.buf) > 0 {
				ack.Reason = r.props().str(mqttPropReasonString)
			}
		}
	}
	if multi {
		ack.Codes = append(ack.Codes, r.buf...)
	}
	return ack, r.err
}

type mqttSubscription struct {
	Topic         string
	QoS           byte
	NoLocal       bool
	RetainAsPub   bool
	RetainHandler byte
}

func mqttSubscribePacket(id uint16, version byte, subs []mqttSubscription) []byte {
	var w mqttWriter
	w.uint16(id)
	if version == 5 {
		w.props(nil)
	}
	for _, sub := range subs {
		w.string(sub.Topic)
		options := sub.QoS & 3
		if version == 5 {
			if sub.NoLocal {
				options |= 0x04
			}
			if sub.RetainAsPub {
				options |= 0x08
			}
			options |= (sub.RetainHandler & 3) << 4
		}
		w.byte(options)
	}
	return mqttFrame(mqttSubscribe, 2, w.buf)
}

func mqttUnsubscribePacket(id uint16, version byte, topics []string) []byte {
	var w mqttWriter
	w.uint16(id)
	if version == 5 {
		w.props(nil)
	}
	for _, topic := range topics {
		w.string(topic)
	}
	return mqttFrame(mqttUnsubscribe, 2, w.buf)
}

func mqttDisconnectPacket(version byte) []byte {
	if version == 5 {
		return mqttFrame(mqttDisconnect, 0, []byte{0, 0})
	}
	return mqttFrame(mqttDisconnect, 0, nil)
}

func decodeMqttDisconnect(body []byte) (byte, string) {
	if len(body) == 0 {
		return 0, ""
	}
	r := &mqttReader{buf: body}
	code := r.byte()
	reason := ""
	if len(r.buf) > 0 {
		reason = r.props().str(mqttPropReasonString)
	}
	return code, reason
}

var mqttConnackV3Codes = map[byte]string{
	1: "the broker does not support this MQTT version",
	2: "the broker rejected the client ID",
	3: "the MQTT service is unavailable",
	4: "bad username or password",
	5: "not authorized",
}

var mqttReasonCodes = map[byte]string{
	0x04: "Disconnect with will message", 0x10: "No matching subscribers", 0x11: "No subscription existed",
	0x80: "Unspecified error", 0x81: "Malformed packet", 0x82: "Protocol error", 0x83: "Implementation specific error",
	0x84: "Unsupported protocol version", 0x85: "Client identifier not valid", 0x86: "Bad user name or password",
	0x87: "Not authorized", 0x88: "Server unavailable", 0x89: "Server busy", 0x8A: "Banned",
	0x8B: "Server shutting down", 0x8C: "Bad authentication method", 0x8D: "Keep alive timeout",
	0x8E: "Session taken over", 0x8F: "Topic filter invalid", 0x90: "Topic name invalid",
	0x91: "Packet identifier in use", 0x92: "Packet identifier not found", 0x93: "Receive maximum exceeded",
	0x94: "Topic alias invalid", 0x95: "Packet too large", 0x96: "Message rate too high", 0x97: "Quota exceeded",
	0x98: "Administrative action", 0x99: "Payload format invalid", 0x9A: "Retain not supported",
	0x9B: "QoS not supported", 0x9C: "Use another server", 0x9D: "Server moved",
	0x9E: "Shared subscriptions not supported", 0x9F: "Connection rate exceeded", 0xA0: "Maximum connect time",
	0xA1: "Subscription identifiers not supported", 0xA2: "Wildcard subscriptions not supported",
}

func mqttReasonText(code byte, reason string) string {
	text := mqttReasonCodes[code]
	if text == "" {
		text = fmt.Sprintf("reason code 0x%02X", code)
	}
	if reason != "" {
		text += ": " + reason
	}
	return text
}

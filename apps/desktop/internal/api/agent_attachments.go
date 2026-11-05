package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type agentAttachment struct {
	id        string
	name      string
	data      []byte
	mediaType string
}

const agentSVGMediaType = "image/svg+xml"

func agentRasterImage(mediaType string) bool {
	switch mediaType {
	case "image/png", "image/jpeg", "image/webp":
		return true
	}
	return false
}

func agentProjectRoot(directory string) (string, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" {
		return "", nil
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("cannot open the selected project folder: %w", err)
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return "", fmt.Errorf("cannot open the selected project folder: %w", err)
	}
	defer root.Close()
	return absolute, nil
}

func loadAgentAttachments(paths []string) ([]agentAttachment, error) {
	if len(paths) > 4 {
		return nil, fmt.Errorf("attach at most four files to a message")
	}
	files := make([]agentAttachment, 0, len(paths))
	total := 0
	for _, path := range paths {
		item, err := loadAgentAttachment(path)
		if err != nil {
			return nil, err
		}
		total += len(item.data)
		if total > 12<<20 {
			return nil, fmt.Errorf("attachments must total at most 12 MiB")
		}
		item.id = uuid.NewString()
		files = append(files, item)
	}
	return files, nil
}

func loadAgentAttachment(path string) (agentAttachment, error) {
	name := filepath.Base(path)
	ext := strings.ToLower(filepath.Ext(name))
	limit := int64(mcpImportLimit)
	raster := false
	switch ext {
	case ".json", ".yaml", ".yml", ".har", ".proto", ".csv", ".txt":
	case ".png", ".jpeg", ".jpg", ".webp":
		limit = 3 << 20
		raster = true
	case ".svg":
		limit = 3 << 20
	default:
		return agentAttachment{}, fmt.Errorf("%s: attach a spec, JSON, HAR, proto, CSV, text, PNG, JPEG, WebP or SVG file", name)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return agentAttachment{}, fmt.Errorf("cannot open attachment %s", name)
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return agentAttachment{}, fmt.Errorf("%s: expected a regular file of at most %d MiB", name, limit>>20)
	}
	file, err := os.Open(path)
	if err != nil {
		return agentAttachment{}, fmt.Errorf("cannot open attachment %s", name)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return agentAttachment{}, fmt.Errorf("%s changed while being attached", name)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return agentAttachment{}, fmt.Errorf("could not read attachment %s within the file size limit", name)
	}
	item := agentAttachment{name: name, data: data}
	if raster {
		item.mediaType = http.DetectContentType(data)
		if !agentRasterImage(item.mediaType) {
			return agentAttachment{}, fmt.Errorf("%s is not a PNG, JPEG or WebP image", name)
		}
	} else if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return agentAttachment{}, fmt.Errorf("%s is not UTF-8 text", name)
	} else if ext == ".svg" {
		var svg struct {
			XMLName xml.Name `xml:"http://www.w3.org/2000/svg svg"`
		}
		if err := xml.Unmarshal(data, &svg); err != nil {
			return agentAttachment{}, fmt.Errorf("%s is not a valid SVG image", name)
		}
		item.mediaType = agentSVGMediaType
	}
	return item, nil
}

func newAgentUserMessage(text string, files []agentAttachment) model.AiMessage {
	message := model.AiMessage{Role: "user", Blocks: []model.AiBlock{{Type: model.AiBlockText, Text: text}}}
	for _, file := range files {
		mediaType := file.mediaType
		if mediaType == "" {
			mediaType = "text/plain"
		}
		attachment := model.AgentAttachment{Name: file.name, ID: file.id, MediaType: mediaType}
		if agentRasterImage(file.mediaType) {
			attachment.Preview = agentImagePreview(file.data)
		} else if file.mediaType == agentSVGMediaType && len(file.data) <= 32<<10 {
			attachment.Preview = agentImageURL(model.AiBlock{MediaType: file.mediaType, Data: base64.StdEncoding.EncodeToString(file.data)})
		}
		message.Attachments = append(message.Attachments, attachment)
	}
	return message
}

func agentImagePreview(data []byte) string {
	const maxPixels = 24_000_000
	const previewSize = 256
	reader := bytes.NewReader(data)
	config, _, err := image.DecodeConfig(reader)
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > maxPixels/config.Height {
		return ""
	}
	reader.Reset(data)
	source, _, err := image.Decode(reader)
	if err != nil {
		return ""
	}
	bounds := source.Bounds()
	scale := min(1, float64(previewSize)/float64(max(bounds.Dx(), bounds.Dy())))
	preview := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(bounds.Dx())*scale)), max(1, int(float64(bounds.Dy())*scale))))
	draw.Draw(preview, preview.Bounds(), image.White, image.Point{}, draw.Src)
	draw.BiLinear.Scale(preview, preview.Bounds(), source, bounds, draw.Over, nil)
	var encoded bytes.Buffer
	if jpeg.Encode(&encoded, preview, &jpeg.Options{Quality: 78}) != nil {
		return ""
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
}

const agentAttachmentHeading = "\n\nFiles attached by the user for this turn:\n"

var legacyAgentAttachmentLine = regexp.MustCompile(`^- ("(?:[^"\\]|\\.)*") \((?:image included with this message|attachment [0-9a-f]{8}, available with read_attachment)\)$`)

func agentDisplayMessage(message model.AiMessage) model.AiMessage {
	if message.Role != "user" || len(message.Attachments) > 0 || len(message.Blocks) != 1 || message.Blocks[0].Type != model.AiBlockText {
		return message
	}
	text := message.Blocks[0].Text
	start := strings.LastIndex(text, agentAttachmentHeading)
	if start <= 0 {
		return message
	}
	lines := strings.Split(text[start+len(agentAttachmentHeading):], "\n")
	if len(lines) > 4 {
		return message
	}
	attachments := make([]model.AgentAttachment, 0, len(lines))
	for _, line := range lines {
		match := legacyAgentAttachmentLine.FindStringSubmatch(line)
		if match == nil {
			return message
		}
		name, err := strconv.Unquote(match[1])
		if err != nil {
			return message
		}
		attachments = append(attachments, model.AgentAttachment{Name: name})
	}
	message.Blocks = []model.AiBlock{{Type: model.AiBlockText, Text: text[:start]}}
	message.Attachments = attachments
	return message
}

func agentAttachmentPrompt(text string, files []model.AgentAttachment) string {
	if len(files) == 0 {
		return text
	}
	lines := make([]string, 0, len(files))
	for _, item := range files {
		if item.ID != "" && !agentRasterImage(item.MediaType) {
			lines = append(lines, fmt.Sprintf("- %q (attachment %s, available with read_attachment)", item.Name, item.ID))
		} else {
			lines = append(lines, fmt.Sprintf("- %q (image included with this message)", item.Name))
		}
	}
	return text + agentAttachmentHeading + strings.Join(lines, "\n")
}

func agentImageBlocks(files []agentAttachment) []model.AiBlock {
	var blocks []model.AiBlock
	for _, item := range files {
		if agentRasterImage(item.mediaType) {
			blocks = append(blocks, model.AiBlock{Type: model.AiBlockImage, MediaType: item.mediaType, Data: base64.StdEncoding.EncodeToString(item.data)})
		}
	}
	return blocks
}

func agentImageURL(block model.AiBlock) string {
	return "data:" + block.MediaType + ";base64," + block.Data
}

func (s *mcpServer) attachment(id string) (agentAttachment, error) {
	for _, item := range s.attachments {
		if item.id == id {
			return item, nil
		}
	}
	return agentAttachment{}, fmt.Errorf("attachment %q is not available in this turn", id)
}

func (s *mcpServer) toolReadAttachment(_ context.Context, arguments json.RawMessage) (any, error) {
	var args knowledgeTextArgs
	if err := mcpDecodeArguments(arguments, &args); err != nil {
		return nil, err
	}
	item, err := s.attachment(args.Attachment)
	if err != nil {
		return nil, err
	}
	if agentRasterImage(item.mediaType) {
		return nil, fmt.Errorf("the selected image is already in the user message")
	}
	out, err := knowledgeText(item.data, args, agentActivitySecrets())
	if err != nil {
		return nil, err
	}
	out["name"], out["attachment"] = item.name, item.id
	return out, nil
}

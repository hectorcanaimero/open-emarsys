package imports

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"unicode/utf8"

	"github.com/minio/minio-go/v7"
	"golang.org/x/text/encoding/charmap"

	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

const (
	sampleSize  = 1 << 20
	previewRows = 20
	utf8Name    = "utf-8"
	latin1Name  = "latin-1"
)

var delimiters = []byte{',', ';', '\t', '|'}

// sniff guesses the encoding and delimiter of a leading sample of a file. truncated says the
// sample ends mid-file, so a cut multi-byte rune at its end is not evidence of Latin-1.
func sniff(sample []byte, truncated bool) (delim byte, enc string) {
	sample = bytes.TrimPrefix(sample, []byte{0xEF, 0xBB, 0xBF})
	valid := sample
	for i := 0; truncated && i < utf8.UTFMax && !utf8.Valid(valid) && len(valid) > 0; i++ {
		valid = valid[:len(valid)-1]
	}
	enc = utf8Name
	if !utf8.Valid(valid) {
		enc = latin1Name
	}
	// Count candidates on the first line, outside quotes.
	counts := map[byte]int{}
	inQuotes := false
loop:
	for _, b := range sample {
		switch {
		case b == '"':
			inQuotes = !inQuotes
		case b == '\n' && !inQuotes:
			break loop
		case !inQuotes:
			counts[b]++
		}
	}
	delim = ','
	best := 0
	for _, d := range delimiters {
		if counts[d] > best {
			delim, best = d, counts[d]
		}
	}
	return delim, enc
}

// newCSVReader decodes r (dropping a UTF-8 BOM) and returns a csv.Reader tolerant of ragged rows,
// which are reported per row instead of aborting the file.
func newCSVReader(r io.Reader, delim, enc string) *csv.Reader {
	if enc == latin1Name {
		r = charmap.ISO8859_1.NewDecoder().Reader(r)
	}
	br := bufio.NewReaderSize(r, 64<<10)
	if b, err := br.Peek(3); err == nil && bytes.Equal(b, []byte{0xEF, 0xBB, 0xBF}) {
		_, _ = br.Discard(3)
	}
	cr := csv.NewReader(br)
	cr.Comma = rune(delim[0])
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	return cr
}

func validOptions(delim, enc string) error {
	if delim != "" && (len(delim) != 1 || bytes.IndexByte(delimiters, delim[0]) < 0) {
		return badRequest("delimiter must be one of , ; tab |")
	}
	if enc != "" && enc != utf8Name && enc != latin1Name {
		return badRequest("encoding must be utf-8 or latin-1")
	}
	return nil
}

// readSample returns the first bytes of the object and whether the file is longer.
func (h *handler) readSample(ctx context.Context, key string) ([]byte, bool, error) {
	obj, err := h.env.Storage.GetObject(ctx, storage.BucketImports, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, false, err
	}
	defer obj.Close()
	sample, err := io.ReadAll(io.LimitReader(obj, sampleSize+1))
	if err != nil {
		if minio.ToErrorResponse(err).StatusCode == 404 {
			err = errNotFound
		}
		return nil, false, err
	}
	if len(sample) > sampleSize {
		return sample[:sampleSize], true, nil
	}
	return sample, false, nil
}

// resolveOptions fills the delimiter and encoding the caller left empty by sniffing the file.
func (h *handler) resolveOptions(ctx context.Context, key, delim, enc string) (string, string, error) {
	if err := validOptions(delim, enc); err != nil {
		return "", "", err
	}
	if delim != "" && enc != "" {
		return delim, enc, nil
	}
	sample, truncated, err := h.readSample(ctx, key)
	if err != nil {
		return "", "", err
	}
	d, e := sniff(sample, truncated)
	if delim == "" {
		delim = string(d)
	}
	if enc == "" {
		enc = e
	}
	return delim, enc, nil
}

func (h *handler) buildPreview(ctx context.Context, key, delim, enc string, hasHeader bool) (map[string]any, error) {
	if err := validOptions(delim, enc); err != nil {
		return nil, err
	}
	sample, truncated, err := h.readSample(ctx, key)
	if err != nil {
		return nil, err
	}
	d, e := sniff(sample, truncated)
	if delim == "" {
		delim = string(d)
	}
	if enc == "" {
		enc = e
	}
	cr := newCSVReader(bytes.NewReader(sample), delim, enc)
	var columns []string
	rows := [][]string{}
	// ponytail: a sample cut mid-row can yield a short last row when rows exceed 1 MiB; irrelevant for 20 rows.
	for len(rows) < previewRows {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil && rec == nil {
			continue
		}
		if columns == nil && hasHeader {
			columns = rec
			continue
		}
		if columns == nil {
			columns = numberedColumns(len(rec))
		}
		rows = append(rows, rec)
	}
	if columns == nil {
		columns = []string{}
	}
	return map[string]any{"delimiter": delim, "encoding": enc, "has_header": hasHeader, "columns": columns, "rows": rows}, nil
}

func numberedColumns(n int) []string {
	cols := make([]string, n)
	for i := range cols {
		cols[i] = fmt.Sprintf("column_%d", i+1)
	}
	return cols
}

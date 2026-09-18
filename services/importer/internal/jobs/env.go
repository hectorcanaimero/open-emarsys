package jobs

import (
	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

// Env is everything a feature package (imports, exports) needs. main builds it once and
// passes it to each package's Register, which mounts routes and calls Queue.Handle.
type Env struct {
	Store    *Store
	Queue    *Queue
	Storage  *storage.Client
	Core     *coreclient.Client
	Verifier *auth.Verifier
}

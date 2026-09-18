package jobs

import (
	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/natsx"
	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

// Env is everything a feature package (imports, exports) needs. main builds it once and
// passes it to each package's Register, which mounts routes and calls Queue.Handle.
type Env struct {
	Store   *Store
	Queue   *Queue
	Storage *storage.Client
	Core    *coreclient.Client
	// CoreURL and CoreTokens let a feature call core endpoints coreclient has no method for.
	CoreURL    string
	CoreTokens *auth.ServiceTokenSource
	Verifier   *auth.Verifier
	Events     *natsx.Client // publishes system.job.completed and friends
}

class PipelineError(RuntimeError):
    """Base class for expected pipeline failures."""


class FetchError(PipelineError):
    """The source page could not be fetched."""


class AccessBlockedError(FetchError):
    """The remote site refused or challenged the request."""


class CircuitOpenError(AccessBlockedError):
    """Collection is paused after repeated source failures or refusals."""


class ExtractionError(PipelineError):
    """The expected embedded page data could not be extracted."""

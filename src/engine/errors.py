class EngineError(RuntimeError):
    """Base class for expected core-engine failures."""


class ValidationError(EngineError):
    """Input data does not satisfy the canonical contract."""


class InsufficientComparablesError(EngineError):
    """No sufficiently similar market records were available."""


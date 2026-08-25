class SourceScraperError(Exception):
    """Base error for query-driven source collection."""


class QueryValidationError(SourceScraperError):
    """The requested property query is inconsistent or incomplete."""


class SourceUnavailableError(SourceScraperError):
    """The requested source has no configured authorised connector."""

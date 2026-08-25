"use client";

import {
  ArrowLeft,
  ArrowRight,
  Bath,
  BedDouble,
  Building2,
  CarFront,
  Check,
  ExternalLink,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Listing = {
  source: string;
  listing_id: string;
  canonical_url: string | null;
  full_address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking_spaces: number | null;
  price_display: string | null;
  weekly_rent: number | null;
  available_date: string | null;
  agency_name: string | null;
  main_image_url: string | null;
  last_seen_at: string;
};

type ListingResponse = { total: number; limit: number; offset: number; items: Listing[] };
type ConnectorStatus = { provider: string; configured: boolean; mode: string; scope: string; message: string };
type SyncResult = { run_id: string; imported: number; skipped: number; pages: number; agency_id: string | null };
type ABSMarketContext = {
  postcode: string;
  area_name: string;
  geography_type: string;
  reference_period: string;
  population: number;
  median_age_years: number;
  private_dwellings: number;
  average_household_size: number | null;
  median_weekly_household_income: number | null;
  median_monthly_mortgage_repayment: number | null;
  median_weekly_rent: number | null;
  irsad_decile: number | null;
  irsad_percentile: number | null;
  source: string;
  source_url: string;
};
type Filters = {
  text: string;
  suburb: string;
  state: string;
  postcode: string;
  propertyType: string;
  bedroomsMin: string;
  bathroomsMin: string;
  weeklyRentMin: string;
  weeklyRentMax: string;
  sort: string;
};

const pageSize = 9;
const initialFilters: Filters = {
  text: "", suburb: "", state: "", postcode: "", propertyType: "", bedroomsMin: "",
  bathroomsMin: "", weeklyRentMin: "", weeklyRentMax: "", sort: "last_seen_at:desc",
};

function buildParameters(filters: Filters, offset: number) {
  const parameters = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  const fields: Array<[keyof Filters, string]> = [
    ["text", "text"], ["suburb", "suburb"], ["state", "state"], ["postcode", "postcode"],
    ["propertyType", "property_type"], ["bedroomsMin", "bedrooms_min"],
    ["bathroomsMin", "bathrooms_min"], ["weeklyRentMin", "weekly_rent_min"],
    ["weeklyRentMax", "weekly_rent_max"],
  ];
  fields.forEach(([key, parameter]) => {
    if (filters[key].trim()) parameters.set(parameter, filters[key].trim());
  });
  const [sortBy, sortOrder] = filters.sort.split(":");
  parameters.set("sort_by", sortBy);
  parameters.set("sort_order", sortOrder);
  return parameters;
}

async function readJson(response: Response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(typeof payload.detail === "string" ? payload.detail : "The request failed.");
  }
  return payload;
}

async function requestListings(filters: Filters, offset = 0) {
  return readJson(await fetch(`/api/listings?${buildParameters(filters, offset)}`, { cache: "no-store" })) as Promise<ListingResponse>;
}

async function requestMarketContext(postcode: string) {
  return readJson(await fetch(`/api/market-context/abs?postcode=${encodeURIComponent(postcode)}`, { cache: "no-store" })) as Promise<ABSMarketContext>;
}

function resolveContextPostcode(filters: Filters, items: Listing[]) {
  if (/^\d{4}$/.test(filters.postcode.trim())) return filters.postcode.trim();
  if (!filters.suburb.trim() || !filters.state.trim()) return null;
  const postcodes = new Set(items.map((item) => item.postcode).filter((value): value is string => Boolean(value)));
  return postcodes.size === 1 ? [...postcodes][0] : null;
}

function formatSeen(value: string) {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function pageMedian(items: Listing[]) {
  const rents = items.map((item) => item.weekly_rent).filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!rents.length) return null;
  const middle = Math.floor(rents.length / 2);
  return rents.length % 2 ? rents[middle] : Math.round((rents[middle - 1] + rents[middle]) / 2);
}

export function PropertySearch() {
  const [filters, setFilters] = useState(initialFilters);
  const [activeFilters, setActiveFilters] = useState(initialFilters);
  const [data, setData] = useState<ListingResponse | null>(null);
  const [connector, setConnector] = useState<ConnectorStatus | null>(null);
  const [agencyId, setAgencyId] = useState("");
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [marketContext, setMarketContext] = useState<ABSMarketContext | null>(null);
  const [marketContextLoading, setMarketContextLoading] = useState(false);
  const [marketContextError, setMarketContextError] = useState<string | null>(null);
  const marketRequest = useRef(0);

  const loadMarketContext = useCallback(async (postcode: string | null) => {
    const requestId = ++marketRequest.current;
    setMarketContextError(null);
    if (!postcode) {
      setMarketContext(null);
      setMarketContextLoading(false);
      return;
    }
    setMarketContextLoading(true);
    try {
      const context = await requestMarketContext(postcode);
      if (requestId === marketRequest.current) setMarketContext(context);
    } catch (reason) {
      if (requestId === marketRequest.current) {
        setMarketContext(null);
        setMarketContextError(reason instanceof Error ? reason.message : "ABS context could not be loaded.");
      }
    } finally {
      if (requestId === marketRequest.current) setMarketContextLoading(false);
    }
  }, []);

  const loadListings = useCallback(async (nextFilters: Filters, offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestListings(nextFilters, offset);
      setData(payload);
      setActiveFilters(nextFilters);
      void loadMarketContext(resolveContextPostcode(nextFilters, payload.items));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The query failed.");
    } finally {
      setLoading(false);
    }
  }, [loadMarketContext]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      requestListings(initialFilters),
      fetch("/api/connectors/rea-partner", { cache: "no-store" }).then(readJson) as Promise<ConnectorStatus>,
    ]).then(([listingResult, connectorResult]) => {
      if (cancelled) return;
      if (listingResult.status === "fulfilled") setData(listingResult.value);
      else setError(listingResult.reason instanceof Error ? listingResult.reason.message : "The query failed.");
      if (connectorResult.status === "fulfilled") setConnector(connectorResult.value);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const median = useMemo(() => data ? pageMedian(data.items) : null, [data]);
  const page = data ? Math.floor(data.offset / data.limit) + 1 : 1;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadListings(filters);
  }

  async function syncListings() {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const response = await fetch("/api/connectors/rea-partner/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agency_id: agencyId.trim() || null, max_pages: 20 }),
      });
      const result = await readJson(response) as SyncResult;
      setSyncResult(result);
      await loadListings(activeFilters);
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : "REA sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="workspace shell" aria-labelledby="search-title">
      <aside className="source-rail">
        <p className="rail-label">Source connector</p>
        <div className="connector-card">
          <div className="connector-topline">
            <span className="rea-monogram">R</span>
            <span className={`status-pill ${connector?.configured ? "ready" : "offline"}`}>
              {connector?.configured ? <Check size={12} /> : <WifiOff size={12} />}
              {connector?.configured ? "Configured" : "Setup required"}
            </span>
          </div>
          <h2>REA Partner</h2>
          <p>Listing Export API</p>
          <dl>
            <div><dt>Format</dt><dd>REAXML</dd></div>
            <div><dt>Scope</dt><dd>Listings export</dd></div>
            <div><dt>Access</dt><dd>Authorised agencies</dd></div>
          </dl>
        </div>

        <div className="sync-card">
          <p>Refresh index</p>
          <label>
            <span>Agency ID <i>optional</i></span>
            <input value={agencyId} onChange={(event) => setAgencyId(event.target.value)} placeholder="e.g. ABC123" maxLength={40} />
          </label>
          <button onClick={() => void syncListings()} disabled={!connector?.configured || syncing}>
            {syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            {syncing ? "Syncing listings…" : "Sync authorised listings"}
          </button>
          {!connector?.configured ? <small>Add server credentials to enable sync.</small> : null}
          {syncResult ? <div className="sync-success"><Check size={15} /><span><strong>{syncResult.imported}</strong> listings synced from {syncResult.pages} page{syncResult.pages === 1 ? "" : "s"}.</span></div> : null}
          {syncError ? <div className="sync-error"><TriangleAlert size={15} /><span>{syncError}</span></div> : null}
        </div>

        <p className="rail-footnote">Credentials and OAuth tokens never enter the browser.</p>
      </aside>

      <div className="search-canvas">
        <div className="canvas-heading">
          <div><p className="section-number">Search / 001</p><h2 id="search-title">Search the listing index</h2></div>
          <p>{data?.total ?? 0} records available</p>
        </div>

        <form onSubmit={submit} className="search-form">
          <label className="primary-search">
            <Search size={21} aria-hidden="true" />
            <span className="sr-only">Address, suburb, or agency</span>
            <input value={filters.text} onChange={(event) => update("text", event.target.value)} placeholder="Address, suburb or agency…" />
            <button type="submit" disabled={loading}>{loading ? <LoaderCircle className="spin" size={18} /> : "Search"}<ArrowRight size={17} /></button>
          </label>

          <div className="quick-filters">
            <FilterSelect label="State" value={filters.state} onChange={(value) => update("state", value)} options={[["", "All states"], ["NSW", "NSW"], ["VIC", "VIC"], ["QLD", "QLD"], ["WA", "WA"], ["SA", "SA"], ["TAS", "TAS"], ["ACT", "ACT"], ["NT", "NT"]]} />
            <TextFilter label="Postcode" value={filters.postcode} onChange={(value) => update("postcode", value.replace(/\D/g, "").slice(0, 4))} placeholder="2000" inputMode="numeric" maxLength={4} pattern="[0-9]{4}" />
            <FilterSelect label="Property" value={filters.propertyType} onChange={(value) => update("propertyType", value)} options={[["", "Any type"], ["Apartment", "Apartment"], ["Unit", "Unit"], ["House", "House"], ["Townhouse", "Townhouse"], ["Studio", "Studio"]]} />
            <FilterSelect label="Beds" value={filters.bedroomsMin} onChange={(value) => update("bedroomsMin", value)} options={[["", "Any"], ["1", "1+"], ["2", "2+"], ["3", "3+"], ["4", "4+"]]} />
            <FilterSelect label="Max rent" value={filters.weeklyRentMax} onChange={(value) => update("weeklyRentMax", value)} options={[["", "No max"], ["600", "$600/wk"], ["800", "$800/wk"], ["1000", "$1,000/wk"], ["1500", "$1,500/wk"]]} />
            <button type="button" className={`advanced-toggle ${advanced ? "active" : ""}`} onClick={() => setAdvanced((value) => !value)}><SlidersHorizontal size={15} /> More filters</button>
          </div>

          {advanced ? <div className="advanced-filters">
            <TextFilter label="Exact suburb" value={filters.suburb} onChange={(value) => update("suburb", value)} placeholder="Parramatta" />
            <FilterSelect label="Bathrooms" value={filters.bathroomsMin} onChange={(value) => update("bathroomsMin", value)} options={[["", "Any"], ["1", "1+"], ["2", "2+"], ["3", "3+"]]} />
            <TextFilter label="Minimum rent" value={filters.weeklyRentMin} onChange={(value) => update("weeklyRentMin", value)} placeholder="$500" inputMode="numeric" />
            <FilterSelect label="Sort by" value={filters.sort} onChange={(value) => update("sort", value)} options={[["last_seen_at:desc", "Recently synced"], ["weekly_rent:asc", "Rent: low first"], ["weekly_rent:desc", "Rent: high first"], ["bedrooms:desc", "Most bedrooms"]]} />
          </div> : null}
        </form>

        {error ? <div className="error-state" role="alert"><TriangleAlert size={24} /><div><strong>Listing API unavailable</strong><span>{error}</span></div><button onClick={() => void loadListings(activeFilters)}>Retry</button></div> : null}

        <ABSContextPanel context={marketContext} loading={marketContextLoading} error={marketContextError} />

        <div className="results-region" aria-live="polite" aria-busy={loading}>
          <div className="results-summary">
            <div><p className="section-number">Results / 002</p><h2>{loading && !data ? "Reading the index…" : `${data?.total ?? 0} matching listings`}</h2></div>
            <dl>
              <div><dt>Visible median</dt><dd>{median ? `$${median.toLocaleString("en-AU")}` : "—"}<small>/ wk</small></dd></div>
              <div><dt>Index</dt><dd className="status-ok"><span /> Local & searchable</dd></div>
            </dl>
          </div>

          {loading && !data ? <LoadingGrid /> : null}
          {!loading && !error && data?.items.length === 0 ? <div className="empty-state"><Building2 size={28} /><h3>No listings match this view.</h3><p>Remove a filter or sync an authorised agency to refresh the index.</p></div> : null}
          {data?.items.length ? <div className={`property-grid ${loading ? "is-refreshing" : ""}`}>{data.items.map((listing, index) => <PropertyCard key={`${listing.source}:${listing.listing_id}`} listing={listing} index={index} />)}</div> : null}

          {data && data.total > 0 ? <nav className="pagination" aria-label="Results pages">
            <button disabled={loading || data.offset === 0} onClick={() => void loadListings(activeFilters, Math.max(0, data.offset - data.limit))}><ArrowLeft size={16} /> Previous</button>
            <p><strong>{page}</strong> / {pageCount}</p>
            <button disabled={loading || data.offset + data.limit >= data.total} onClick={() => void loadListings(activeFilters, data.offset + data.limit)}>Next <ArrowRight size={16} /></button>
          </nav> : null}
        </div>
      </div>
    </section>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label className="filter-control"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option value={optionValue} key={`${label}-${optionValue}`}>{text}</option>)}</select></label>;
}

function TextFilter({ label, value, onChange, placeholder, inputMode, maxLength, pattern }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; inputMode?: "numeric"; maxLength?: number; pattern?: string }) {
  return <label className="filter-control"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} inputMode={inputMode} maxLength={maxLength} pattern={pattern} /></label>;
}

function money(value: number | null) {
  return value === null ? "—" : `$${value.toLocaleString("en-AU")}`;
}

function ABSContextPanel({ context, loading, error }: { context: ABSMarketContext | null; loading: boolean; error: string | null }) {
  return <section className="abs-context" aria-labelledby="abs-context-title" aria-busy={loading}>
    <div className="abs-context-heading">
      <div><p className="section-number">Local context / ABS</p><h2 id="abs-context-title">Census snapshot</h2></div>
      {context ? <a href={context.source_url} target="_blank" rel="noreferrer">View ABS source <ExternalLink size={13} /></a> : <span>Free · no credentials</span>}
    </div>
    {loading ? <div className="abs-context-message">Reading the official ABS postcode profile…</div> : null}
    {!loading && error ? <div className="abs-context-message error"><TriangleAlert size={17} /> {error}</div> : null}
    {!loading && !error && !context ? <div className="abs-context-message"><MapPin size={17} /> Add a postcode to compare listings with local demographic and housing context.</div> : null}
    {!loading && context ? <>
      <div className="abs-context-location"><strong>{context.area_name}</strong><span>{context.geography_type} · {context.reference_period}</span></div>
      <div className="abs-metrics">
        <MarketMetric label="People" value={context.population.toLocaleString("en-AU")} />
        <MarketMetric label="Median age" value={`${context.median_age_years} yrs`} />
        <MarketMetric label="Private dwellings" value={context.private_dwellings.toLocaleString("en-AU")} />
        <MarketMetric label="Household income" value={`${money(context.median_weekly_household_income)} / wk`} />
        <MarketMetric label="Census rent" value={`${money(context.median_weekly_rent)} / wk`} />
        <MarketMetric label="Mortgage repayment" value={`${money(context.median_monthly_mortgage_repayment)} / mo`} />
      </div>
      <p className="abs-context-note">{context.irsad_decile ? `Socio-economic advantage/disadvantage: national decile ${context.irsad_decile}/10 (percentile ${context.irsad_percentile}/100). ` : ""}Census figures are historical context and are not current asking rents or valuations.</p>
    </> : null}
  </section>;
}

function MarketMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function PropertyCard({ listing, index }: { listing: Listing; index: number }) {
  const location = [listing.suburb, listing.state, listing.postcode].filter(Boolean).join(" ");
  return <article className="property-card" style={{ "--delay": `${index * 45}ms` } as React.CSSProperties}>
    <div className={`property-visual ${listing.main_image_url ? "has-image" : ""}`} style={listing.main_image_url ? { backgroundImage: `url("${listing.main_image_url.replaceAll('"', "%22")}")` } : undefined}>
      <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
      <span className="source-tag">{listing.source === "rea-partner" ? "REA Partner" : listing.source}</span>
    </div>
    <div className="card-body">
      <div className="card-kicker"><span>{listing.property_type ?? "Rental"}</span><span>Synced {formatSeen(listing.last_seen_at)}</span></div>
      <h3>{listing.full_address ?? `Listing ${listing.listing_id}`}</h3>
      <p className="location"><MapPin size={14} /> {location || "Location unavailable"}</p>
      <div className="feature-row" aria-label="Property features"><span><BedDouble size={16} /> {listing.bedrooms ?? "—"}</span><span><Bath size={16} /> {listing.bathrooms ?? "—"}</span><span><CarFront size={16} /> {listing.parking_spaces ?? "—"}</span></div>
      <div className="card-footer"><div><small>Asking rent</small><strong>{listing.weekly_rent ? `$${listing.weekly_rent.toLocaleString("en-AU")}` : listing.price_display ?? "On application"}</strong>{listing.weekly_rent ? <span>per week</span> : null}</div>{listing.canonical_url ? <a href={listing.canonical_url} target="_blank" rel="noreferrer" aria-label={`Open ${listing.full_address ?? listing.listing_id}`}><ExternalLink size={17} /></a> : null}</div>
      <p className="agency">{listing.agency_name ? `Agency ${listing.agency_name}` : "Agency not supplied"}</p>
    </div>
  </article>;
}

function LoadingGrid() {
  return <div className="property-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <div className="skeleton-card" key={index}><span /><span /><span /><span /></div>)}</div>;
}

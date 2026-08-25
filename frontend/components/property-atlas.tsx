"use client";

import {
  Activity,
  ArrowRight,
  BarChart3,
  Bath,
  BedDouble,
  Building2,
  CalendarDays,
  Camera,
  CarFront,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Database,
  FileText,
  Home,
  KeyRound,
  Landmark,
  Layers3,
  LoaderCircle,
  MapPin,
  Ruler,
  Search,
  ShieldCheck,
  Sparkles,
  Waves,
  Wind,
} from "lucide-react";
import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { BatchReports } from "@/components/batch-reports";

type Suggestion = {
  propertyId: number | string;
  suggestion: string;
  suggestionType: string;
  isActiveProperty?: boolean;
  isUnit?: boolean;
};

type ModuleResult = {
  ok: boolean;
  status: number;
  data: unknown;
  message?: string;
  cacheStatus?: "HIT" | "MISS";
  cachedAt?: string;
  expiresAt?: string;
};

type Profile = {
  propertyId: number;
  scope?: string;
  generatedAt: string;
  successfulModules: number;
  totalModules: number;
  availableModules?: number;
  cache?: { hits: number; misses: number; ttlSeconds: number };
  modules: Record<string, ModuleResult>;
};

type Tab = "overview" | "comparables" | "market" | "legal" | "intelligence" | "sources" | "data";
type JsonRecord = Record<string, unknown>;
type PropertyImage = {
  digitalAssetType?: string;
  largePhotoUrl?: string;
  mediumPhotoUrl?: string;
  thumbnailPhotoUrl?: string;
  basePhotoUrl?: string;
  scanDate?: string;
};

type ComparableCandidate = {
  propertyId: number;
  address: string;
  imageUrl: string | null;
  campaign: string | null;
  propertyType: string | null;
  beds: number | null;
  baths: number | null;
  carSpaces: number | null;
  floorArea: number | null;
  landArea: number | null;
  localityId: number;
  distanceKm: number | null;
  score: { total: number; breakdown: Record<string, number> };
};

type Comparables = {
  reference: { localityId: number; coordinateAvailable: boolean };
  candidatePool: { localityId: number; forSale: boolean; forRent: boolean; discovered: number; enriched: number };
  candidates: ComparableCandidate[];
};

const exampleAddresses = [
  "2 Albert Avenue Broadbeach QLD 4218",
  "1 Macquarie Street Sydney NSW 2000",
  "120 Collins Street Melbourne VIC 3000",
];

const moduleLabels: Record<string, string> = {
  core: "Core attributes",
  additional: "Additional features",
  location: "Validated location",
  site: "Site details",
  features: "Complete features",
  legal: "Legal description",
  contacts: "Property contacts",
  occupancy: "Occupancy",
  developmentApplications: "Development applications",
  lastSale: "Last recorded sale",
  sales: "Sales history",
  timeline: "Property timeline",
  statistics: "Market references",
  forSale: "Sale advertisements",
  forRent: "Rental advertisements",
  onMarketSales: "On-market sale campaigns",
  onMarketRent: "On-market rental campaigns",
  avm: "Consumer AVM",
  rentalAvm: "Rental AVM",
  images: "Property imagery",
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function money(value: unknown) {
  const amount = number(value);
  return amount === null ? "Not available" : new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(amount);
}

function date(value: unknown) {
  if (typeof value !== "string" || !value) return "Date unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
}

function findNumber(value: unknown, names: string[]): number | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue: unknown[] = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      const numericChild = number(child);
      if (wanted.has(key.toLowerCase()) && numericChild !== null) return numericChild;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function findString(value: unknown, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue: unknown[] = [value];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item as JsonRecord)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string" && child.trim()) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || "The request could not be completed.");
  return payload as T;
}

export function PropertyAtlas() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [comparables, setComparables] = useState<Comparables | null>(null);
  const [loadingComparables, setLoadingComparables] = useState(false);
  const [comparablesError, setComparablesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const requestSequence = useRef(0);
  const loadedScopes = useRef(new Set<string>());
  const loadingScopes = useRef(new Set<string>());

  async function searchAddress(value = query) {
    const cleaned = value.trim();
    if (cleaned.length < 3) return;
    const requestId = ++requestSequence.current;
    setSearching(true);
    setError(null);
    try {
      const payload = await responseJson<{ suggestions: Suggestion[] }>(
        await fetch(`/api/corelogic/search?q=${encodeURIComponent(cleaned)}`),
      );
      if (requestId === requestSequence.current) setSuggestions(payload.suggestions.slice(0, 8));
    } catch (reason) {
      if (requestId === requestSequence.current) setError(reason instanceof Error ? reason.message : "Address search failed.");
    } finally {
      if (requestId === requestSequence.current) setSearching(false);
    }
  }

  useEffect(() => {
    if (query.trim().length < 4 || selected?.suggestion === query) return;
    const timer = window.setTimeout(() => void searchAddress(query), 360);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function openProperty(suggestion: Suggestion) {
    const propertyId = Number(suggestion.propertyId);
    if (!Number.isSafeInteger(propertyId) || propertyId <= 0) {
      setError("Cotality returned an address suggestion without a valid property record. Please choose another match.");
      return;
    }
    setSelected(suggestion);
    setQuery(suggestion.suggestion);
    setSuggestions([]);
    setLoadingProfile(true);
    setProfile(null);
    setComparables(null);
    setComparablesError(null);
    setError(null);
    setTab("overview");
    loadedScopes.current.clear();
    loadingScopes.current.clear();
    try {
      const payload = await responseJson<Profile>(
        await fetch(`/api/corelogic/properties/${propertyId}`),
      );
      setProfile(payload);
      loadedScopes.current.add("overview");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The property profile could not be loaded.");
    } finally {
      setLoadingProfile(false);
    }
  }

  async function loadComparables(propertyId: number) {
    setLoadingComparables(true);
    setComparablesError(null);
    try {
      const payload = await responseJson<Comparables>(await fetch(`/api/corelogic/properties/${propertyId}/comparables`));
      setComparables(payload);
    } catch (reason) {
      setComparablesError(reason instanceof Error ? reason.message : "Comparable properties could not be loaded.");
    } finally {
      setLoadingComparables(false);
    }
  }

  async function loadProfileScope(propertyId: number, scope: "market" | "legal" | "intelligence" | "all") {
    if (loadedScopes.current.has(scope) || loadingScopes.current.has(scope)) return;
    loadingScopes.current.add(scope);
    try {
      const payload = await responseJson<Profile>(await fetch(`/api/corelogic/properties/${propertyId}?scope=${scope}`));
      setProfile((current) => {
        if (!current || current.propertyId !== propertyId) return current;
        const modules = { ...current.modules, ...payload.modules };
        const cacheHits = (current.cache?.hits || 0) + (payload.cache?.hits || 0);
        const cacheMisses = (current.cache?.misses || 0) + (payload.cache?.misses || 0);
        return {
          ...payload,
          modules,
          successfulModules: Object.values(modules).filter((module) => module.ok).length,
          totalModules: Object.keys(modules).length,
          cache: { hits: cacheHits, misses: cacheMisses, ttlSeconds: payload.cache?.ttlSeconds || current.cache?.ttlSeconds || 300 },
        };
      });
      loadedScopes.current.add(scope);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Additional property evidence could not be loaded.");
    } finally {
      loadingScopes.current.delete(scope);
    }
  }

  function changeTab(nextTab: Tab, propertyId: number) {
    setTab(nextTab);
    if (nextTab === "comparables" && !comparables && !loadingComparables) {
      void loadComparables(propertyId);
    }
    const scopeByTab: Partial<Record<Tab, "market" | "legal" | "intelligence" | "all">> = {
      market: "market",
      legal: "legal",
      intelligence: "intelligence",
      sources: "all",
      data: "all",
    };
    const scope = scopeByTab[nextTab];
    if (scope) void loadProfileScope(propertyId, scope);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void searchAddress();
  }

  function chooseExample(address: string) {
    setSelected(null);
    setProfile(null);
    setComparables(null);
    setComparablesError(null);
    setQuery(address);
    void searchAddress(address);
  }

  return (
    <main className="atlas-page">
      <header className="atlas-header">
        <a className="atlas-brand" href="#top" aria-label="Parcel Atlas home">
          <span className="atlas-brand-mark"><Layers3 size={21} /></span>
          <span><strong>Parcel Atlas</strong><small>Australian property intelligence</small></span>
        </a>
        <nav className="atlas-nav" aria-label="Product sections">
          <a href="#search">Search</a><a href="#profile">Property</a><a href="#batch-reports">Batch reports</a><a href="#connectors">Sources</a>
        </nav>
        <div className="secure-note"><ShieldCheck size={15} /><span>Secure server connection</span></div>
      </header>

      <section className="atlas-hero" id="top">
        <div className="hero-grid-lines" aria-hidden="true" />
        <div className="hero-number">AU / 01</div>
        <div className="hero-title">
          <p>Property evidence, assembled.</p>
          <h1>Find the address.<br /><em>Read the whole story.</em></h1>
        </div>
        <div className="hero-brief">
          <span className="live-dot" />
          <p>One address unlocks property attributes, market evidence, advertisements, valuations and local context from the Cotality API estate.</p>
        </div>
        <div className="hero-stat"><strong>177</strong><span>mapped API operations</span></div>
      </section>

      <section className="atlas-search-zone" id="search">
        <div className="search-intro">
          <p className="micro-label">Property finder / Cotality Search API</p>
          <h2>Start with any Australian address</h2>
        </div>
        <div className="search-stage">
          <form className="atlas-search" onSubmit={submit}>
            <Search size={24} />
            <label className="sr-only" htmlFor="property-query">Search an Australian property address</label>
            <input
              id="property-query"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSelected(null); }}
              placeholder="Try 2 Albert Avenue, Broadbeach…"
              autoComplete="off"
            />
            <button disabled={searching || query.trim().length < 3}>
              {searching ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
              <span>{searching ? "Finding" : "Search"}</span>
            </button>
          </form>

          {suggestions.length > 0 ? (
            <div className="suggestion-panel" role="listbox" aria-label="Address suggestions">
              <div className="suggestion-heading"><span>{suggestions.length} validated matches</span><span>CoreLogic property ID</span></div>
              {suggestions.map((suggestion, index) => (
                <button key={`${suggestion.propertyId}-${suggestion.suggestion}-${index}`} onClick={() => void openProperty(suggestion)} role="option" aria-selected={String(selected?.propertyId) === String(suggestion.propertyId)}>
                  <span className="suggestion-icon">{suggestion.isUnit ? <Building2 size={18} /> : <Home size={18} />}</span>
                  <span className="suggestion-copy"><strong>{suggestion.suggestion}</strong><small>{suggestion.isUnit ? "Strata property" : "Property"} · Active record</small></span>
                  <span className="suggestion-id">#{suggestion.propertyId}</span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
          ) : null}

          <div className="example-row">
            <span>Example searches</span>
            {exampleAddresses.map((address) => <button key={address} onClick={() => chooseExample(address)}>{address.split(" ").slice(0, 3).join(" ")}…</button>)}
          </div>
          {error ? <div className="atlas-error"><CircleDashed size={18} /><span>{error}</span></div> : null}
        </div>
      </section>

      <section className="profile-stage" id="profile">
        {!selected && !loadingProfile ? <EmptyProfile /> : null}
        {loadingProfile && selected ? <LoadingProfile address={selected.suggestion} /> : null}
        {selected && profile ? <PropertyDossier selected={selected} profile={profile} tab={tab} onTabChange={(nextTab) => changeTab(nextTab, profile.propertyId)} comparables={comparables} loadingComparables={loadingComparables} comparablesError={comparablesError} retryComparables={() => void loadComparables(profile.propertyId)} /> : null}
      </section>

      <BatchReports />

      <ConnectorMap />

      <footer className="atlas-footer">
        <div><Layers3 size={17} /><strong>Parcel Atlas</strong></div>
        <p>Cotality sandbox data · Entitlement-aware · Credentials remain server-side</p>
        <p>AU / {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
}

function EmptyProfile() {
  return <div className="empty-profile">
    <div className="empty-orbit"><span /><span /><MapPin size={25} /></div>
    <p className="micro-label">Property dossier / awaiting selection</p>
    <h2>A profile will assemble here.</h2>
    <p>Search above and select a validated address. Parcel Atlas will query twenty property, legal, planning, market and valuation modules in parallel.</p>
  </div>;
}

function LoadingProfile({ address }: { address: string }) {
  return <div className="loading-profile">
    <div className="loading-copy"><LoaderCircle className="spin" size={24} /><span><strong>Assembling property dossier</strong><small>{address}</small></span></div>
    <div className="module-loader">{Object.values(moduleLabels).map((label, index) => <span key={label} style={{ "--i": index } as React.CSSProperties}>{label}</span>)}</div>
  </div>;
}

function PropertyDossier({ selected, profile, tab, onTabChange, comparables, loadingComparables, comparablesError, retryComparables }: { selected: Suggestion; profile: Profile; tab: Tab; onTabChange: (tab: Tab) => void; comparables: Comparables | null; loadingComparables: boolean; comparablesError: string | null; retryComparables: () => void }) {
  const core = record(profile.modules.core?.data);
  const additional = record(profile.modules.additional?.data);
  const location = record(profile.modules.location?.data);
  const lastSale = record(profile.modules.lastSale?.data);
  const saleAds = array(record(profile.modules.forSale?.data).forSaleAdvertisementList).map(record);
  const rentAds = array(record(profile.modules.forRent?.data).forRentAdvertisementList).map(record);
  const avmValue = findNumber(profile.modules.avm?.data, ["estimate", "avmEstimate", "consumerAvmEstimate", "estimatedValue", "value", "amount"]);
  const rentalValue = findNumber(profile.modules.rentalAvm?.data, ["rentalAvmEstimate", "estimate", "estimatedRent", "rent", "amount"]);
  const rentalLow = findNumber(profile.modules.rentalAvm?.data, ["rentalAvmEstimateLow"]);
  const rentalHigh = findNumber(profile.modules.rentalAvm?.data, ["rentalAvmEstimateHigh"]);
  const rentalValuationDate = findString(profile.modules.rentalAvm?.data, ["rentalAvmValuationDate"]);
  const rentalPeriod = findString(profile.modules.rentalAvm?.data, ["rentalAvmPeriod"]);
  const rentalPeriodLabel = rentalPeriod === "W" ? "wk" : rentalPeriod === "M" ? "month" : "period";
  const rentalDetail = rentalValue === null
    ? "CoreLogic returned no rental valuation for this property record."
    : rentalLow !== null && rentalHigh !== null
      ? `Model range ${money(rentalLow)}–${money(rentalHigh)} / ${rentalPeriodLabel} · valued ${date(rentalValuationDate)}`
      : `Current automated rent estimate · valued ${date(rentalValuationDate)}`;
  const saleValue = findNumber(lastSale, ["price", "salePrice", "saleAmount", "amount"]);
  const saleDate = findString(lastSale, ["date", "saleDate", "contractDate", "settlementDate"]);
  const latestPricedAdvertisement = [...saleAds]
    .filter((item) => findNumber(item, ["price"]) !== null)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
  const advertisedPrice = findNumber(latestPricedAdvertisement, ["price"]);
  const advertisedDate = findString(latestPricedAdvertisement, ["date"]);
  const coverage = Math.round((profile.successfulModules / profile.totalModules) * 100);
  const imageData = record(profile.modules.images?.data);
  const propertyImages = [
    record(imageData.defaultImage),
    ...array(imageData.secondaryImageList).map(record),
    ...array(imageData.floorPlanImageList).map(record),
  ].filter((item) => text(item.largePhotoUrl || item.mediumPhotoUrl || item.basePhotoUrl, "") !== "") as PropertyImage[];

  const dossierTabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Property" },
    { id: "comparables", label: "Similar homes" },
    { id: "market", label: "Market trail" },
    { id: "legal", label: "Legal & planning" },
    { id: "intelligence", label: "Intelligence" },
    { id: "sources", label: "Data sources" },
    { id: "data", label: "All API data" },
  ];

  const metrics = [
    { icon: BedDouble, label: "Bedrooms", value: number(core.beds)?.toString() || "—" },
    { icon: Bath, label: "Bathrooms", value: number(core.baths)?.toString() || "—" },
    { icon: CarFront, label: "Car spaces", value: number(core.carSpaces)?.toString() || "—" },
    { icon: Ruler, label: "Land area", value: number(core.landArea) === null ? "—" : `${number(core.landArea)} m²` },
    { icon: Home, label: "Floor area", value: number(additional.floorArea) === null ? "—" : `${number(additional.floorArea)} m²` },
    { icon: CalendarDays, label: "Year built", value: text(additional.yearBuilt) },
  ];

  return <article className="dossier">
    <header className="dossier-header">
      <div className="property-code"><span>Property record</span><strong>CL–{profile.propertyId}</strong></div>
      <div className="property-heading">
        <p><MapPin size={14} /> {text(location.councilArea, "Validated Australian address")}</p>
        <h2>{text(location.singleLine, selected.suggestion)}</h2>
        <div className="property-tags"><span>{text(core.propertyType, selected.isUnit ? "UNIT" : "PROPERTY")}</span><span>{text(core.propertySubTypeShort, "Active record")}</span><span>{text(location.state)}</span><span>{profile.cache?.hits || 0}/{profile.totalModules} cache hits</span></div>
      </div>
      <div className="coverage-gauge" style={{ "--coverage": `${coverage * 3.6}deg` } as React.CSSProperties}>
        <div><strong>{profile.successfulModules}</strong><span>of {profile.totalModules}<br />modules live</span></div>
      </div>
    </header>

    <ImageGallery images={propertyImages} address={text(location.singleLine, selected.suggestion)} />

    <nav className="dossier-tabs" aria-label="Property profile sections">
      {dossierTabs.map((item, index) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => onTabChange(item.id)}><span>0{index + 1}</span>{item.label}</button>)}
    </nav>

    {tab === "overview" ? <div className="dossier-overview">
      <section className="property-facts">
        <div className="section-heading"><div><p className="micro-label">Physical profile</p><h3>What stands on the parcel</h3></div><span>Live Cotality attributes</span></div>
        <div className="metric-grid">{metrics.map(({ icon: Icon, label, value }) => <div key={label}><Icon size={18} /><span>{label}</span><strong>{value}</strong></div>)}</div>
        <div className="feature-strip">
          <Feature active={additional.airConditioned === true} icon={Wind} label="Air conditioned" />
          <Feature active={additional.pool === true} icon={Waves} label="Pool" />
          <Feature active={number(additional.tennisCourt) !== null} icon={Activity} label="Tennis court" />
          <Feature active={core.isActiveProperty === true} icon={Check} label="Active property" />
        </div>
      </section>
      <aside className="valuation-panel">
        <p className="micro-label">Value evidence</p>
        <h3>What the data can support</h3>
        <ValueSignal
          label="Consumer AVM"
          value={avmValue === null ? "No confident estimate" : money(avmValue)}
          detail={avmValue === null ? "Insufficient property or recent-sales evidence for CoreLogic to model a value." : "Current automated market estimate."}
          status={avmValue === null ? `Unavailable · API ${profile.modules.avm?.status || "—"}` : "Modelled estimate"}
        />
        <ValueSignal
          label="Rental AVM"
          value={rentalValue === null ? "No rental valuation" : `${money(rentalValue)} / ${rentalPeriodLabel}`}
          detail={rentalDetail}
          status={rentalValue === null ? `Unavailable · API ${profile.modules.rentalAvm?.status || "—"}` : "Modelled estimate"}
        />
        <ValueSignal
          label={saleValue !== null ? "Last recorded sale" : advertisedPrice !== null ? "Latest asking price" : "Market evidence"}
          value={saleValue !== null ? money(saleValue) : advertisedPrice !== null ? money(advertisedPrice) : "No price evidence"}
          detail={saleValue !== null ? date(saleDate) : advertisedPrice !== null ? `Advertised ${date(advertisedDate)} · not a completed sale` : "No sale amount or priced advertisement was returned."}
          status={saleValue !== null ? "Registered sale" : advertisedPrice !== null ? "Advertisement evidence" : `No sale data · API ${profile.modules.lastSale?.status || "—"}`}
          accent={saleValue !== null || advertisedPrice !== null}
        />
        <p className="valuation-note"><Sparkles size={14} /> Model estimates, asking prices and completed sales are kept distinct.</p>
      </aside>
    </div> : null}

    {tab === "comparables" ? <ComparablesView referenceAddress={text(location.singleLine, selected.suggestion)} comparables={comparables} loading={loadingComparables} error={comparablesError} retry={retryComparables} /> : null}

    {tab === "market" ? <MarketTrail saleAds={saleAds} rentAds={rentAds} lastSale={lastSale} /> : null}
    {tab === "legal" ? <LegalPlanningView profile={profile} /> : null}
    {tab === "intelligence" ? <IntelligenceView profile={profile} /> : null}
    {tab === "sources" ? <ModuleStatus profile={profile} /> : null}
    {tab === "data" ? <AllDataView profile={profile} /> : null}
  </article>;
}

function ImageGallery({ images, address }: { images: PropertyImage[]; address: string }) {
  const [active, setActive] = useState(0);
  const selected = images[active];
  const source = selected?.largePhotoUrl || selected?.mediumPhotoUrl || selected?.basePhotoUrl || "";

  if (!images.length) {
    return <section className="property-gallery empty-gallery"><Camera size={25} /><div><strong>No property imagery returned</strong><span>The image module is available, but this record has no digital assets.</span></div></section>;
  }

  function move(direction: number) {
    setActive((current) => (current + direction + images.length) % images.length);
  }

  return <section className="property-gallery" aria-label={`Property imagery for ${address}`}>
    <div className="gallery-main">
      <Image key={source} src={source} alt={`${address}, image ${active + 1}`} fill sizes="(max-width: 760px) 100vw, 1200px" priority />
      <div className="gallery-shade" />
      <div className="gallery-meta"><span><Camera size={14} /> Cotality property imagery</span><strong>{String(active + 1).padStart(2, "0")} / {String(images.length).padStart(2, "0")}</strong></div>
      <button className="gallery-prev" onClick={() => move(-1)} aria-label="Previous property image"><ChevronLeft size={22} /></button>
      <button className="gallery-next" onClick={() => move(1)} aria-label="Next property image"><ChevronRight size={22} /></button>
      <span className="gallery-date">Captured {date(selected.scanDate)}</span>
    </div>
    <div className="gallery-thumbs" aria-label="Choose property image">
      {images.map((image, index) => {
        const thumbnail = image.thumbnailPhotoUrl || image.mediumPhotoUrl || image.largePhotoUrl || image.basePhotoUrl || "";
        return <button key={`${thumbnail}-${index}`} className={index === active ? "active" : ""} onClick={() => setActive(index)} aria-label={`Show property image ${index + 1}`} aria-pressed={index === active}>
          <Image src={thumbnail} alt="" fill sizes="92px" />
          <span>{String(index + 1).padStart(2, "0")}</span>
        </button>;
      })}
    </div>
  </section>;
}

function Feature({ active, icon: Icon, label }: { active: boolean; icon: typeof Wind; label: string }) {
  return <span className={active ? "active" : ""}><Icon size={15} />{label}<small>{active ? "Recorded" : "Not recorded"}</small></span>;
}

function ValueSignal({ label, value, detail, status, accent = false }: { label: string; value: string; detail: string; status: string; accent?: boolean }) {
  return <div className={`valuation-item${accent ? " has-evidence" : ""}`}>
    <div className="valuation-label"><span>{label}</span><em>{status}</em></div>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>;
}

function ComparablesView({ referenceAddress, comparables, loading, error, retry }: { referenceAddress: string; comparables: Comparables | null; loading: boolean; error: string | null; retry: () => void }) {
  if (loading) {
    return <section className="comparables-view comparables-loading"><LoaderCircle className="spin" size={24} /><div><p className="micro-label">Comparable engine / assembling</p><h3>Finding local properties with the closest configuration.</h3><p>We are searching the exact CoreLogic locality, then refreshing the strongest candidates with their authoritative property records.</p></div></section>;
  }

  if (error) {
    return <section className="comparables-view comparables-empty"><CircleDashed size={25} /><div><p className="micro-label">Comparable engine / unavailable</p><h3>Local matches could not be assembled.</h3><p>{error}</p><button onClick={retry}>Try again <ArrowRight size={15} /></button></div></section>;
  }

  if (!comparables) return null;
  const candidates = comparables.candidates;
  return <section className="comparables-view">
    <header className="comparables-heading">
      <div><p className="micro-label">Comparable engine / live locality search</p><h3>Similar homes, with the evidence visible.</h3></div>
      <p>Starting from <strong>{referenceAddress}</strong>, the engine searches locality <strong>#{comparables.reference.localityId}</strong>, enriches the best candidates, and scores the final records.</p>
    </header>
    <div className="comparison-method">
      <div><span>01 / discover</span><strong>{comparables.candidatePool.discovered}</strong><small>local candidates</small></div>
      <div><span>02 / enrich</span><strong>{comparables.candidatePool.enriched}</strong><small>authoritative records</small></div>
      <div><span>03 / locate</span><strong>{comparables.reference.coordinateAvailable ? "Distance" : "Locality"}</strong><small>{comparables.reference.coordinateAvailable ? "Haversine calculation" : "coordinate fallback"}</small></div>
      <div><span>04 / rank</span><strong>100</strong><small>point model</small></div>
    </div>
    <div className="comparables-note"><MapPin size={16} /><span>{comparables.reference.coordinateAvailable ? "Distance is calculated from latitude/longitude using the Haversine formula. Exact locality is used to source candidates." : "The reference property has no usable coordinate, so matches are ranked within the exact locality without a distance bonus."}</span></div>
    {candidates.length ? <div className="comparable-list">{candidates.map((candidate, index) => {
      const signals = [
        candidate.score.breakdown.type ? "Type" : null,
        candidate.score.breakdown.bedrooms ? "Beds" : null,
        candidate.score.breakdown.bathrooms ? "Baths" : null,
        candidate.score.breakdown.cars ? "Parking" : null,
        candidate.score.breakdown.area ? "Area" : null,
        candidate.score.breakdown.location ? candidate.distanceKm === null ? "Locality" : "Distance" : null,
      ].filter(Boolean);
      return <article className="comparable-card" key={candidate.propertyId}>
        <div className="comparable-rank"><span>{String(index + 1).padStart(2, "0")}</span><strong>{candidate.score.total}</strong><small>/100 match</small></div>
        <div className="comparable-image">{candidate.imageUrl ? <Image src={candidate.imageUrl} alt={candidate.address} fill sizes="(max-width: 760px) 100vw, 230px" /> : <Home size={26} />}<span>{candidate.propertyType || "Property"}</span></div>
        <div className="comparable-details"><h4>{candidate.address}</h4><p>{candidate.beds ?? "—"} bed · {candidate.baths ?? "—"} bath · {candidate.carSpaces ?? "—"} car{candidate.floorArea ? ` · ${candidate.floorArea} m² floor` : candidate.landArea ? ` · ${candidate.landArea} m² land` : ""}</p><div className="match-signals">{signals.map((signal) => <span key={signal}>{signal}</span>)}</div></div>
        <div className="comparable-market"><span>{candidate.distanceKm === null ? "Same locality" : `${candidate.distanceKm.toFixed(2)} km away`}</span><strong>{candidate.campaign || "No current price"}</strong><small>Campaign data, where returned</small></div>
      </article>;
    })}</div> : <div className="comparables-empty"><MapPin size={25} /><div><p className="micro-label">Comparable engine / no candidates</p><h3>No local candidates were returned.</h3><p>The locality search endpoints responded, but did not provide properties that could be enriched for this address.</p></div></div>}
    <footer className="comparison-weights"><span>Score weights</span><p>Type 35 · bedrooms 20 · bathrooms 15 · car spaces 10 · floor/land area 10 · locality or distance 10</p></footer>
  </section>;
}

function MarketTrail({ saleAds, rentAds, lastSale }: { saleAds: JsonRecord[]; rentAds: JsonRecord[]; lastSale: JsonRecord }) {
  const combined: Array<JsonRecord & { kind: string }> = [
    ...saleAds.slice(0, 6).map((item): JsonRecord & { kind: string } => ({ ...item, kind: "For sale advertisement" })),
    ...rentAds.slice(0, 4).map((item): JsonRecord & { kind: string } => ({ ...item, kind: "Rental advertisement" })),
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const saleValue = findNumber(lastSale, ["price", "salePrice", "saleAmount", "amount"]);
  const saleDate = findString(lastSale, ["date", "saleDate", "contractDate", "settlementDate"]);
  const latestPricedAdvertisement = saleAds.find((item) => findNumber(item, ["price"]) !== null);
  const advertisedValue = findNumber(latestPricedAdvertisement, ["price"]);
  const advertisedDate = findString(latestPricedAdvertisement, ["date"]);

  return <div className="market-layout">
    <section className="market-timeline">
      <div className="section-heading"><div><p className="micro-label">Market evidence</p><h3>Advertisement trail</h3></div><span>{combined.length} visible events</span></div>
      {combined.length ? <div className="timeline-list">{combined.map((item, index) => {
        const advertiser = record(array(item.advertiserList)[0]);
        const agency = record(record(advertiser.agency).company);
        return <article key={`${String(item.advertisementId)}-${index}`}>
          <div className="timeline-marker"><span /></div>
          <div><p>{date(item.date)}</p><h4>{text(item.kind)}</h4><span>{text(item.method, "Method not supplied")} · {text(agency.companyName, "Agency unavailable")}</span></div>
          <strong>{text(item.priceDescription, money(item.price))}</strong>
        </article>;
      })}</div> : <div className="no-events"><BarChart3 size={24} /><h4>No advertisement history returned</h4><p>This record may have no history or your product entitlement may exclude it.</p></div>}
    </section>
    <aside className="market-summary">
      <p className="micro-label">{saleValue !== null ? "Recorded sale" : advertisedValue !== null ? "Latest asking price" : "Recorded sale"}</p>
      <h3>{saleValue !== null ? money(saleValue) : advertisedValue !== null ? money(advertisedValue) : "No price returned"}</h3>
      <span>{saleValue !== null ? date(saleDate) : advertisedValue !== null ? `${date(advertisedDate)} · advertisement` : "No dated sale evidence"}</span>
      <div className="market-rule" /><p>{saleValue === null && advertisedValue !== null ? "This is an advertised asking price, not a confirmed transaction. " : ""}Market events come from Cotality advertisements and sales modules. Duplicate advertisements may represent separate source observations.</p>
    </aside>
  </div>;
}

function meaningfulRows(value: unknown) {
  return flattenData(value).filter((row) =>
    !/(^|\.)isActiveProperty$/.test(row.path) &&
    !row.path.startsWith("systemInfo") &&
    !["{}", "[]", "null"].includes(row.value),
  );
}

function recordsFrom(value: unknown, keys: string[]) {
  if (Array.isArray(value)) return value.map(record).filter((item) => Object.keys(item).length > 0);
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return array(source[key]).map(record).filter((item) => Object.keys(item).length > 0);
  }
  return [];
}

function EvidenceDrawer({ title, data, empty }: { title: string; data: unknown; empty: string }) {
  const rows = meaningfulRows(data);
  return <details className="evidence-drawer">
    <summary><span>{title}</span><em>{rows.length ? `${rows.length} returned fields` : "No records"}</em><ChevronRight size={16} /></summary>
    {rows.length ? <div className="evidence-table">{rows.map((row, index) => <div key={`${row.path}-${index}`}><code>{row.path}</code>{/^https?:\/\//.test(row.value) ? <a href={row.value} target="_blank" rel="noreferrer">Open source <ArrowRight size={11} /></a> : <span>{row.value}</span>}</div>)}</div> : <p>{empty}</p>}
  </details>;
}

function LegalPlanningView({ profile }: { profile: Profile }) {
  const legalData = record(profile.modules.legal?.data);
  const titleData = record(legalData.title);
  const legalDetail = record(legalData.legal);
  const parcels = recordsFrom(legalData, ["parcels", "parcelList"]);
  const primaryParcel = parcels[0] || {};
  const contactsData = profile.modules.contacts?.data;
  const occupancyData = profile.modules.occupancy?.data;
  const developmentData = profile.modules.developmentApplications?.data;
  const contactRows = meaningfulRows(contactsData);
  const occupancyRows = meaningfulRows(occupancyData);
  const developmentRecords = recordsFrom(developmentData, ["developmentApplications", "developmentApplicationList", "applications"]);
  const developmentRows = meaningfulRows(developmentData);
  const occupancyLabel = findString(occupancyData, ["occupancyType", "occupancy", "status", "description"]);

  return <div className="legal-planning-view">
    <header className="evidence-view-heading">
      <div><p className="micro-label">Legal, parcel & planning evidence</p><h3>The property behind the address</h3></div>
      <p>Title, land-authority, occupancy and planning records remain separate from marketing claims and modelled values.</p>
    </header>
    <section className="title-ledger">
      <div className="title-ledger-mark"><Landmark size={29} /><span>Title<br />record</span></div>
      <div className="title-ledger-main"><span>Title indicator</span><strong>{text(titleData.titleIndicator, "No title indicator returned")}</strong><small>{text(primaryParcel.landAuthority, "Land authority unavailable")}</small></div>
      <div className="title-stat"><span>Parcels</span><strong>{parcels.length || "—"}</strong></div>
      <div className="title-stat"><span>Frontage</span><strong>{number(legalDetail.frontage) === null ? "—" : `${number(legalDetail.frontage)} m`}</strong></div>
      <div className="title-stat"><span>Parcel area</span><strong>{text(primaryParcel.area, "—")}</strong></div>
    </section>
    <section className="record-pulse-grid">
      <article><FileText size={19} /><span>Occupancy</span><strong>{occupancyLabel || (occupancyRows.length ? "Record returned" : "No record")}</strong><small>{occupancyRows.length} evidence fields</small></article>
      <article><Building2 size={19} /><span>Property contacts</span><strong>{contactRows.length ? "Records available" : "No contacts returned"}</strong><small>{contactRows.length} evidence fields</small></article>
      <article><CalendarDays size={19} /><span>Development applications</span><strong>{developmentRecords.length || (developmentRows.length ? 1 : 0)}</strong><small>{developmentRows.length ? "planning records returned" : "No applications returned"}</small></article>
    </section>
    <section className="evidence-drawer-list">
      <EvidenceDrawer title="Legal and parcel response" data={legalData} empty="No legal or parcel evidence was returned for this property." />
      <EvidenceDrawer title="Occupancy response" data={occupancyData} empty="The endpoint is connected, but no occupancy classification was returned." />
      <EvidenceDrawer title="Property contacts response" data={contactsData} empty="The endpoint is connected, but no contact records were returned." />
      <EvidenceDrawer title="Development applications response" data={developmentData} empty="The endpoint is connected, but no development applications were returned." />
    </section>
  </div>;
}

function IntelligenceView({ profile }: { profile: Profile }) {
  const featureData = record(profile.modules.features?.data);
  const featureNames = array(featureData.features).filter((item): item is string => typeof item === "string");
  const featureAttributes = array(featureData.featureAttributes).map(record);
  const sales = recordsFrom(profile.modules.sales?.data, ["saleList", "sales"]);
  const saleCampaignRoot = record(record(profile.modules.onMarketSales?.data).forSalePropertyCampaign);
  const rentCampaignRoot = record(record(profile.modules.onMarketRent?.data).forRentPropertyCampaign);
  const saleCampaigns = recordsFrom(saleCampaignRoot, ["campaigns"]);
  const rentCampaigns = recordsFrom(rentCampaignRoot, ["campaigns"]);
  const campaignObservations: Array<JsonRecord & { campaignKind: string }> = [
    ...saleCampaigns.map((item): JsonRecord & { campaignKind: string } => ({ ...item, campaignKind: "Sale campaign" })),
    ...rentCampaigns.map((item): JsonRecord & { campaignKind: string } => ({ ...item, campaignKind: "Rental campaign" })),
  ];
  const seenCampaigns = new Set<string>();
  const campaigns = campaignObservations.filter((campaign) => {
    const key = `${campaign.campaignKind}-${String(campaign.advertisementId)}-${String(campaign.fromDate)}-${String(campaign.toDate)}`;
    if (seenCampaigns.has(key)) return false;
    seenCampaigns.add(key);
    return true;
  }).sort((a, b) => String(b.fromDate || "").localeCompare(String(a.fromDate || "")));
  const statistics = record(profile.modules.statistics?.data);

  return <div className="intelligence-view">
    <header className="evidence-view-heading intelligence-heading">
      <div><p className="micro-label">Expanded property intelligence</p><h3>Evidence beyond the brochure</h3></div>
      <p>Complete features, campaign behaviour, recorded transactions and official statistical geography in one traceable view.</p>
    </header>
    <div className="intelligence-grid">
      <section className="feature-inventory">
        <div className="section-heading"><div><p className="micro-label">Complete feature service</p><h3>Recorded characteristics</h3></div><span>{featureNames.length + featureAttributes.length} signals</span></div>
        {featureNames.length || featureAttributes.length ? <div className="feature-inventory-list">
          {featureNames.map((item) => <span key={item}><Check size={12} />{item}</span>)}
          {featureAttributes.map((item, index) => <span key={`${text(item.name)}-${index}`}><Activity size={12} /><b>{text(item.name)}</b><em>{text(item.value)}</em></span>)}
        </div> : <div className="compact-empty">No complete-feature records were returned.</div>}
      </section>
      <section className="geography-card">
        <p className="micro-label">Statistical geography</p>
        <h3>{text(statistics.statisticalArea2Name, "No area record")}</h3>
        <div><span>Local government</span><strong>{text(statistics.localGovernmentAreaName)}</strong></div>
        <div><span>Capital-city region</span><strong>{text(statistics.greaterCapitalCityStatisticalAreaName)}</strong></div>
        <div><span>State suburb</span><strong>{text(statistics.stateSuburbName)}</strong></div>
        <div><span>Census reference</span><strong>{text(statistics.censusYear)}</strong></div>
      </section>
    </div>
    <section className="campaign-section">
      <div className="section-heading"><div><p className="micro-label">On-market campaign service</p><h3>Campaign behaviour</h3></div><span>{campaigns.filter((item) => item.campaignKind === "Sale campaign").length} sale · {campaigns.filter((item) => item.campaignKind === "Rental campaign").length} rent</span></div>
      {campaigns.length ? <div className="campaign-grid">{campaigns.slice(0, 8).map((campaign, index) => {
        const agency = record(campaign.agency);
        const priceValue = findNumber(campaign, ["latestAdvertisementPrice", "price", "firstPublishedPrice", "firstAdvertisementPrice"]);
        return <article key={`${text(campaign.campaignKind)}-${text(campaign.advertisementId)}-${index}`}>
          <div><span>{text(campaign.campaignKind)}</span><em>{campaign.isActiveCampaign === true ? "Active" : "Closed"}</em></div>
          <strong>{text(campaign.priceDescription, money(priceValue))}</strong>
          <p>{date(campaign.fromDate)} → {date(campaign.toDate)}</p>
          <small>{number(campaign.daysOnMarket) ?? number(campaign.daysListed) ?? "—"} days on market · {text(agency.companyName, "Agency unavailable")}</small>
        </article>;
      })}</div> : <div className="compact-empty">No on-market campaigns were returned for this property.</div>}
    </section>
    <section className="sales-history-section">
      <div className="section-heading"><div><p className="micro-label">Full sales service</p><h3>Recorded transaction history</h3></div><span>{sales.length} transactions</span></div>
      {sales.length ? <div className="sales-history-list">{sales.slice(0, 10).map((sale, index) => <article key={`${findString(sale, ["saleDate", "date"])}-${index}`}>
        <span>{date(findString(sale, ["saleDate", "contractDate", "settlementDate", "date"]))}</span>
        <strong>{money(findNumber(sale, ["salePrice", "price", "saleAmount", "amount"]))}</strong>
        <small>{text(findString(sale, ["saleType", "saleMethod", "method"]), "Recorded transaction")}</small>
      </article>)}</div> : <div className="compact-empty">The sales endpoint is connected, but no completed transactions were returned for this record.</div>}
    </section>
  </div>;
}

function moduleLedgerState(name: string, result: ModuleResult) {
  if (result.ok) {
    const data = record(result.data);
    if (name === "lastSale" && findNumber(data, ["price", "salePrice", "saleAmount", "amount"]) === null) {
      return { kind: "connected", label: "Connected", description: "The endpoint responded, but this property has no registered sale amount or date." };
    }
    if (name === "forRent" && array(data.forRentAdvertisementList).length === 0) {
      return { kind: "connected", label: "Connected", description: "The endpoint responded; no rental advertisements exist for this property." };
    }
    if (meaningfulRows(result.data).length === 0) {
      return { kind: "connected", label: "Connected", description: "The endpoint is working, but it returned no property-level records for this address." };
    }
    return { kind: "connected", label: result.cacheStatus === "HIT" ? "Cached" : "Live", description: "Data returned from the Cotality sandbox." };
  }

  if (result.status === 404) {
    if (name === "statistics") return { kind: "empty", label: "No record", description: "This property has no statistical-reference record. The endpoint works for other properties." };
    if (name === "avm") return { kind: "empty", label: "No estimate", description: "CoreLogic could not produce a confident consumer AVM for this property." };
    if (name === "rentalAvm") return { kind: "empty", label: "No valuation", description: "No rental AVM exists for this property. The endpoint works for other properties." };
    return { kind: "empty", label: "No record", description: "The endpoint is reachable, but no data exists for this property." };
  }

  if (name === "timeline" && result.status >= 500) {
    return { kind: "error", label: "Provider error", description: "CoreLogic's sandbox timeline route is misconfigured; the same routing error occurs across tested properties." };
  }
  if (result.status === 403) return { kind: "restricted", label: "Not entitled", description: "This API product is not enabled for the current application." };
  if (result.status === 401) return { kind: "error", label: "Auth error", description: "CoreLogic rejected the application credentials for this module." };
  return { kind: "error", label: `API ${result.status || "error"}`, description: result.message || "The upstream service could not complete this request." };
}

function ModuleStatus({ profile }: { profile: Profile }) {
  const entries = Object.entries(profile.modules).map(([name, result]) => ({ name, result, state: moduleLedgerState(name, result) }));
  const connected = entries.filter(({ state }) => state.kind === "connected").length;
  const empty = entries.filter(({ state }) => state.kind === "empty").length;
  const errors = entries.filter(({ state }) => state.kind === "error" || state.kind === "restricted").length;

  return <div className="module-status-view">
    <div className="section-heading"><div><p className="micro-label">Response-aware diagnostics</p><h3>Data module ledger</h3></div><span>{connected} connected · {empty} no-record · {errors} provider/restricted</span></div>
    <div className="module-status-grid">{entries.map(({ name, state }, index) => <article key={name}>
      <span className="module-index">{String(index + 1).padStart(2, "0")}</span>
      <div><h4>{moduleLabels[name] || name}</h4><p>{state.description}</p></div>
      <span className={`module-state ${state.kind}`}>{state.kind === "connected" ? <Check size={13} /> : <CircleDashed size={13} />}{state.label}</span>
    </article>)}</div>
  </div>;
}

function flattenData(value: unknown, prefix = "", rows: Array<{ path: string; value: string }> = []) {
  if (value === null || value === undefined) {
    rows.push({ path: prefix || "value", value: "null" });
    return rows;
  }
  if (Array.isArray(value)) {
    if (!value.length) rows.push({ path: prefix || "value", value: "[]" });
    value.forEach((item, index) => flattenData(item, `${prefix}[${index}]`, rows));
    return rows;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonRecord);
    if (!entries.length) rows.push({ path: prefix || "value", value: "{}" });
    entries.forEach(([key, child]) => flattenData(child, prefix ? `${prefix}.${key}` : key, rows));
    return rows;
  }
  rows.push({ path: prefix || "value", value: typeof value === "boolean" ? (value ? "true" : "false") : String(value) });
  return rows;
}

function AllDataView({ profile }: { profile: Profile }) {
  const totalFields = Object.values(profile.modules).reduce((sum, module) => sum + flattenData(module.data).length, 0);
  return <section className="all-data-view">
    <div className="section-heading all-data-heading"><div><p className="micro-label">Complete response explorer</p><h3>Every field returned by the APIs</h3></div><span>{totalFields.toLocaleString("en-AU")} response fields · {profile.totalModules} modules</span></div>
    <p className="all-data-intro">Fields are grouped by their source endpoint. Expand any module to inspect its full normalized response; image URLs, identifiers, messages and metadata are retained.</p>
    <div className="data-module-list">{Object.entries(profile.modules).map(([name, result], index) => {
      const rows = flattenData(result.data);
      return <details key={name} open={index < 3}>
        <summary><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{moduleLabels[name] || name}</strong><small>{rows.length} fields · HTTP {result.status} · {result.cacheStatus === "HIT" ? "server cache" : "upstream response"}</small></div><ChevronRight size={17} /></summary>
        <div className="data-table">{rows.map((row, rowIndex) => <div key={`${row.path}-${rowIndex}`}><code>{row.path}</code>{/^https?:\/\//.test(row.value) ? <a href={row.value} target="_blank" rel="noreferrer">Open asset <ArrowRight size={12} /></a> : <span>{row.value}</span>}</div>)}</div>
      </details>;
    })}</div>
    <details className="raw-json"><summary>Raw JSON response <span>developer view</span></summary><pre>{JSON.stringify(profile, null, 2)}</pre></details>
  </section>;
}

function ConnectorMap() {
  const connectors = [
    { id: "01", icon: KeyRound, name: "Property Tree", state: "External", className: "external", detail: "Tenant, ledger, maintenance and inspections", coverage: "Requires authorised Property Tree connector" },
    { id: "02", icon: Database, name: "Cotality", state: "Live", className: "live", detail: "Property, sales, AVM, market and location", coverage: "Primary property intelligence source" },
    { id: "03", icon: Home, name: "REA listings", state: "Partial", className: "partial", detail: "On-market advertisements via Cotality", coverage: "Agency feed required for guaranteed completeness" },
    { id: "04", icon: Landmark, name: "PriceFinder", state: "Mapped", className: "mapped", detail: "Sales, comparables and valuation evidence", coverage: "Substituted by Cotality property modules" },
    { id: "05", icon: FileText, name: "Supplementary", state: "Partial", className: "partial", detail: "Schools, census, auctions and reports", coverage: "Cotality plus government open data" },
  ];
  return <section className="connector-map" id="connectors">
    <div className="connector-heading"><div><p className="micro-label">Source connector map</p><h2>One workspace, honest coverage.</h2></div><p>The interface distinguishes live Cotality modules from external connectors that still need separate authorization.</p></div>
    <div className="connector-grid">{connectors.map(({ id, icon: Icon, name, state, className, detail, coverage }) => <article key={name}>
      <div className="connector-card-top"><span>{id}</span><span className={`connector-state ${className}`}>{state}</span></div>
      <Icon size={24} /><h3>{name}</h3><p>{detail}</p><small>{coverage}</small>
    </article>)}</div>
  </section>;
}

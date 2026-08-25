from __future__ import annotations

from html import escape
from urllib.parse import urlparse

from engine.models import ComparableMatch, EngineReport, TenantScore


def render_html_report(report: EngineReport) -> str:
    """Render a self-contained, printable owner report."""
    market = report.market
    current_rent = report.subject.current_weekly_rent
    change = (
        market.suggested_weekly_rent - current_rent
        if current_rent is not None
        else None
    )
    change_label = "Not supplied"
    if change is not None:
        direction = "above" if change >= 0 else "below"
        change_label = f"${abs(change):,} {direction} current"

    comparable_rows = "".join(
        _comparable_row(index, item)
        for index, item in enumerate(market.selected, start=1)
    )
    issues = _issues(report)
    tenant = _tenant_section(report.tenant)
    confidence = escape(market.confidence.value.title())
    subject = report.subject

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Market &amp; Tenancy Brief — {escape(subject.address)}</title>
  <style>{_CSS}</style>
  <style>{_CALCULATION_CSS}</style>
</head>
<body>
  <main class="report-shell">
    <header class="masthead reveal">
      <div class="brand-lockup">
        <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M7 22.5 24 8l17 14.5V41H7Z" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M17 41V27h14v14M13 20h22" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <div><p class="eyebrow">Owner advisory</p><h1>Market &amp; Tenancy Brief</h1></div>
      </div>
      <div class="report-meta">
        <span>Run {escape(report.run_id[:8].upper())}</span>
        <span>{escape(report.generated_at.strftime('%d %B %Y'))}</span>
      </div>
    </header>

    <section class="property-intro reveal delay-1">
      <div>
        <p class="section-kicker">Subject property</p>
        <h2>{escape(subject.address)}</h2>
        <p class="locality">{escape(subject.suburb)}, {escape(subject.state)} {escape(subject.postcode)}</p>
      </div>
      <dl class="property-facts">
        <div><dt>Type</dt><dd>{escape(subject.property_type.title())}</dd></div>
        <div><dt>Beds</dt><dd>{subject.bedrooms}</dd></div>
        <div><dt>Baths</dt><dd>{subject.bathrooms}</dd></div>
        <div><dt>Parking</dt><dd>{subject.parking_spaces}</dd></div>
      </dl>
    </section>

    <section class="recommendation reveal delay-2" aria-labelledby="recommendation-title">
      <div class="recommendation-copy">
        <p class="section-kicker light">Market recommendation</p>
        <h2 id="recommendation-title"><span class="currency">$</span>{market.suggested_weekly_rent:,}<small>/ week</small></h2>
        <p>{escape(report_to_market_sentence(report))}</p>
      </div>
      <div class="recommendation-stats">
        <div><span>Observed range</span><strong>${market.low_weekly_rent:,}–${market.high_weekly_rent:,}</strong></div>
        <div><span>Current position</span><strong>{escape(change_label)}</strong></div>
        <div><span>Confidence</span><strong class="confidence {market.confidence.value}">{confidence}</strong></div>
      </div>
    </section>

    <section class="evidence-grid reveal delay-3">
      <article class="metric-card">
        <span class="metric-index">01</span><p>Comparables selected</p>
        <strong>{len(market.selected)}</strong><small>best-fit records</small>
      </article>
      <article class="metric-card">
        <span class="metric-index">02</span><p>Average match</p>
        <strong>{market.average_match_score:.1f}<sup>%</sup></strong><small>configuration + location</small>
      </article>
      <article class="metric-card">
        <span class="metric-index">03</span><p>Records excluded</p>
        <strong>{market.rejected_count}</strong><small>rules, quality or outliers</small>
      </article>
      <article class="metric-card">
        <span class="metric-index">04</span><p>Rule set</p>
        <strong class="rule-version">{escape(market.rule_version)}</strong><small>reproducible calculation</small>
      </article>
    </section>

    <section class="report-section comparables reveal" aria-labelledby="comparables-title">
      <div class="section-heading">
        <div><p class="section-kicker">Evidence register</p><h2 id="comparables-title">Selected comparables</h2></div>
        <p>Ranked by similarity. Advertised rents are observations, not confirmed lease outcomes.</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Property</th><th>Configuration</th><th>Weekly rent</th><th>Match</th></tr></thead>
          <tbody>{comparable_rows}</tbody>
        </table>
      </div>
    </section>

    {_calculation_section(report)}

    {tenant}

    <section class="report-section methodology reveal">
      <div class="section-heading">
        <div><p class="section-kicker">Decision trail</p><h2>Methodology &amp; limitations</h2></div>
      </div>
      <div class="method-grid">
        <div><h3>How the range was formed</h3><p>Records were normalized, checked for required fields, filtered by locality and configuration, scored for similarity, and screened for rent outliers. The recommendation is the rounded median of the selected evidence.</p></div>
        <div><h3>How to interpret confidence</h3><p>Confidence reflects the number and similarity of available records. It does not guarantee a leasing outcome and should be reviewed alongside condition, presentation, timing and licensed market evidence.</p></div>
        <div><h3>Data limitations</h3><p>{issues}</p></div>
        <div><h3>Human review</h3><p>This report supports—not replaces—professional judgment. Tenant scoring, when present, uses documented tenancy events only and must remain subject to authorised human review.</p></div>
      </div>
    </section>

    <footer>
      <p>Prepared from normalized source records · Market rules {escape(market.rule_version)}{_tenant_rule(report.tenant)}</p>
      <p>Audit reference {escape(report.run_id)}</p>
    </footer>
  </main>
</body>
</html>"""


def report_to_market_sentence(report: EngineReport) -> str:
    market = report.market
    return (
        f"The evidence supports a weekly market range of "
        f"${market.low_weekly_rent:,} to ${market.high_weekly_rent:,}, "
        f"centred on ${market.suggested_weekly_rent:,}."
    )


def _comparable_row(index: int, match: ComparableMatch) -> str:
    item = match.comparable
    address = escape(item.address or f"Address withheld — {item.suburb}")
    link = _safe_link(item.canonical_url, address)
    reasons = " · ".join(escape(reason) for reason in match.reasons[:3])
    return f"""
      <tr>
        <td class="rank">{index:02d}</td>
        <td><div class="address">{link}</div><div class="reasons">{reasons}</div></td>
        <td><span class="configuration">{item.bedrooms} bd&nbsp; / &nbsp;{item.bathrooms} ba&nbsp; / &nbsp;{item.parking_spaces} car</span></td>
        <td class="rent">${item.weekly_rent:,}</td>
        <td><div class="score"><span style="width:{min(100, max(0, match.score)):.0f}%"></span></div><b>{match.score:.1f}</b></td>
      </tr>"""


def _safe_link(url: str | None, label: str) -> str:
    if not url:
        return label
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return label
    return f'<a href="{escape(url, quote=True)}">{label}</a>'


def _tenant_section(score: TenantScore | None) -> str:
    if score is None:
        return """
    <section class="report-section tenant reveal">
      <div class="section-heading">
        <div><p class="section-kicker">Authorised tenancy evidence</p><h2>Tenant scorecard</h2></div>
        <span class="not-assessed">Not assessed</span>
      </div>
      <div class="empty-state"><strong>No tenant metrics supplied</strong><p>The market report remains complete. A tenant score will appear only when authorised Property Tree data is provided.</p></div>
    </section>"""


def _calculation_section(report: EngineReport) -> str:
    market = report.market
    calculation = market.calculation
    subject = report.subject
    received = int(report.metadata.get("market_records_received", 0))
    valid = int(report.metadata.get("market_records_valid", 0))
    hard_rejected = sum(calculation.hard_filter_rejections.values())
    rejection_rows = "".join(
        f"<li><span>{escape(reason.title())}</span><b>{count}</b></li>"
        for reason, count in calculation.hard_filter_rejections.items()
    ) or "<li><span>No hard-filter rejections</span><b>0</b></li>"
    selected_rents = " · ".join(f"${rent:,}" for rent in calculation.selected_rents)
    first_match = market.selected[0]
    maximums = {
        "property_type": 20,
        "bedrooms": 20,
        "bathrooms": 15,
        "parking": 10,
        "location": 25,
        "recency": 10,
    }
    component_rows = "".join(
        f"<li><span>{escape(name.replace('_', ' ').title())}</span>"
        f"<b>{points:.1f} / {maximums[name]}</b></li>"
        for name, points in first_match.components.items()
    )
    outlier_text = "Not applied — fewer than four matching records."
    if calculation.rent_iqr is not None:
        outlier_text = (
            f"Q1 ${calculation.rent_first_quartile:,.2f}; Q3 "
            f"${calculation.rent_third_quartile:,.2f}; IQR "
            f"${calculation.rent_iqr:,.2f}. Accepted range "
            f"${calculation.rent_lower_bound:,.2f}–"
            f"${calculation.rent_upper_bound:,.2f}."
        )
    confidence_pass = (
        len(market.selected) >= calculation.high_confidence_minimum_count
        and market.average_match_score
        >= calculation.high_confidence_minimum_score
    )
    return f"""
    <section class="report-section calculation reveal" aria-labelledby="calculation-title">
      <div class="section-heading">
        <div><p class="section-kicker">Input-specific calculation</p><h2 id="calculation-title">Calculation trail</h2></div>
        <p>Every value below was produced for this subject property and this run—not copied from a generic example.</p>
      </div>
      <div class="query-profile">
        <span>Query profile</span>
        <strong>{subject.bedrooms} bed · {subject.bathrooms} bath · {subject.parking_spaces} car · {escape(subject.property_type.title())}</strong>
        <small>{escape(subject.suburb)}, {escape(subject.state)} {escape(subject.postcode)} · current rent {_money(subject.current_weekly_rent)}</small>
      </div>
      <div class="trace-grid">
        <article><span class="trace-number">01</span><h3>Normalize</h3><p><b>{received}</b> received → <b>{valid}</b> valid → <b>{len(report.data_issues)}</b> quarantined.</p></article>
        <article><span class="trace-number">02</span><h3>Hard filters</h3><p><b>{hard_rejected}</b> rejected before scoring.</p><ul>{rejection_rows}</ul></article>
        <article><span class="trace-number">03</span><h3>Similarity</h3><p><b>{calculation.passed_similarity}</b> passed the minimum score of {calculation.minimum_score:.0f}.</p><p class="formula-note">Top match: {first_match.score:.1f}/100</p><ul>{component_rows}</ul></article>
        <article><span class="trace-number">04</span><h3>Outliers</h3><p>{escape(outlier_text)}</p><p class="formula-note"><b>{calculation.rent_outliers_removed}</b> rent outlier(s) removed.</p></article>
        <article class="wide"><span class="trace-number">05</span><h3>Rank &amp; select</h3><p>Kept the top <b>{calculation.maximum_comparables}</b> by subject-specific similarity; <b>{calculation.top_n_excluded}</b> lower-ranked matches were excluded.</p><p class="rent-sequence">{selected_rents}</p></article>
        <article><span class="trace-number">06</span><h3>Aggregate</h3><p>Median <b>${calculation.selected_median:,.2f}</b> → rounded suggestion <b>${market.suggested_weekly_rent:,}</b>.</p><p class="formula-note">Selected Q1 ${calculation.selected_first_quartile:,.2f} · Q3 ${calculation.selected_third_quartile:,.2f}</p></article>
        <article><span class="trace-number">07</span><h3>Confidence</h3><p>{len(market.selected)} records ≥ {calculation.high_confidence_minimum_count}; average score {market.average_match_score:.1f} ≥ {calculation.high_confidence_minimum_score:.0f}.</p><p class="formula-note">High-confidence test: <b>{'Passed' if confidence_pass else 'Not passed'}</b></p></article>
      </div>
    </section>"""


def _money(value: int | None) -> str:
    return f"${value:,}/week" if value is not None else "not supplied"
    component_rows = "".join(
        f"<li><span>{escape(name.replace('_', ' ').title())}</span><b>{points:.1f}</b></li>"
        for name, points in score.components.items()
    )
    reasons = "".join(f"<li>{escape(reason)}</li>" for reason in score.reasons)
    return f"""
    <section class="report-section tenant reveal">
      <div class="section-heading">
        <div><p class="section-kicker">Authorised tenancy evidence</p><h2>Tenant scorecard</h2></div>
        <span class="tenant-rating {score.rating.value}">{escape(score.rating.value.title())}</span>
      </div>
      <div class="tenant-layout">
        <div class="score-orbit"><strong>{score.score}</strong><span>/ 100</span></div>
        <ul class="component-list">{component_rows}</ul>
        <div class="tenant-reasons"><h3>Recorded reasons</h3><ul>{reasons}</ul></div>
      </div>
    </section>"""


def _issues(report: EngineReport) -> str:
    if not report.data_issues:
        return (
            "No input records were quarantined during this run. Missing fields in "
            "source listings may still limit individual comparisons."
        )
    return (
        f"{len(report.data_issues)} source records were quarantined during validation. "
        "They were excluded from the recommendation and retained in the run evidence."
    )


def _tenant_rule(score: TenantScore | None) -> str:
    return f" · Tenant rules {escape(score.rule_version)}" if score else ""


_CALCULATION_CSS = r"""
.calculation{background:#fffaf1;border-top:1px solid var(--line)}
.query-profile{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:22px;padding:18px 22px;background:var(--ink);color:#f8f2e8;margin-bottom:28px}
.query-profile>span{text-transform:uppercase;letter-spacing:.12em;font-size:.62rem;color:#e5a58d}
.query-profile strong{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.25rem;font-weight:500}
.query-profile small{color:#c9d0cb}
.trace-grid{display:grid;grid-template-columns:repeat(2,1fr);border-top:1px solid var(--line);border-left:1px solid var(--line)}
.trace-grid article{position:relative;padding:26px 28px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-height:180px}
.trace-grid article.wide{grid-column:1/-1;min-height:auto}
.trace-number{position:absolute;right:16px;top:14px;font-family:monospace;font-size:.63rem;color:var(--accent)}
.trace-grid h3{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.35rem;margin-bottom:10px}
.trace-grid p{font-size:.78rem;color:var(--muted)}
.trace-grid ul{list-style:none;padding:0;margin:12px 0 0}
.trace-grid li{display:flex;justify-content:space-between;gap:20px;padding:5px 0;border-top:1px solid rgba(216,210,198,.65);font-size:.69rem;color:var(--muted)}
.formula-note{padding:8px 10px;background:#eee8dd;color:var(--ink)!important}
.rent-sequence{font-family:monospace;color:var(--ink)!important;line-height:1.8}
@media(max-width:820px){.query-profile{grid-template-columns:1fr;gap:5px}.trace-grid{grid-template-columns:1fr}.trace-grid article.wide{grid-column:auto}}
@media print{.calculation,.trace-grid article{break-inside:avoid}}
"""


_CSS = r"""
:root{--paper:#f3efe6;--card:#fffdf8;--ink:#17231f;--muted:#6e766f;--line:#d8d2c6;--accent:#bd5b3d;--moss:#4c695b;--gold:#caa65b;--navy:#1b302d}
*{box-sizing:border-box}html{background:#d8d4cc;scroll-behavior:smooth}body{margin:0;color:var(--ink);font-family:"Avenir Next",Avenir,"Century Gothic",sans-serif;background:radial-gradient(circle at 8% 4%,rgba(189,91,61,.13),transparent 24rem),linear-gradient(135deg,#e5e0d7,#cbc8c1);line-height:1.5}.report-shell{width:min(1180px,calc(100% - 40px));margin:32px auto;background:var(--paper);box-shadow:0 28px 80px rgba(23,35,31,.18);overflow:hidden}.masthead{display:flex;align-items:center;justify-content:space-between;padding:34px 54px;border-bottom:1px solid var(--line)}.brand-lockup{display:flex;align-items:center;gap:16px}.brand-mark{width:42px;color:var(--accent)}h1,h2,h3,p{margin-top:0}.eyebrow,.section-kicker{text-transform:uppercase;letter-spacing:.16em;font-weight:700;font-size:.7rem;margin:0 0 7px;color:var(--accent)}h1{font-family:"Iowan Old Style",Baskerville,"Palatino Linotype",serif;font-size:1.7rem;line-height:1;margin:0;font-weight:600}.report-meta{display:flex;gap:22px;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.08em}.property-intro{padding:56px 54px 45px;display:grid;grid-template-columns:1.35fr 1fr;gap:50px;align-items:end}.property-intro h2,.section-heading h2{font-family:"Iowan Old Style",Baskerville,"Palatino Linotype",serif;font-weight:500;line-height:1.08}.property-intro h2{font-size:clamp(2rem,4vw,3.6rem);max-width:760px;margin:0 0 10px}.locality{color:var(--muted);font-size:1rem}.property-facts{display:grid;grid-template-columns:repeat(4,1fr);margin:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.property-facts div{padding:15px 10px;border-right:1px solid var(--line)}.property-facts div:last-child{border:0}.property-facts dt{font-size:.65rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.property-facts dd{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.35rem;margin:3px 0 0}.recommendation{margin:0 28px;background:var(--navy);color:#f6f1e8;display:grid;grid-template-columns:1.25fr 1fr;min-height:280px;position:relative;overflow:hidden}.recommendation:after{content:"";position:absolute;width:260px;height:260px;border:1px solid rgba(255,255,255,.12);border-radius:50%;right:-90px;top:-120px;box-shadow:0 0 0 42px rgba(255,255,255,.025),0 0 0 84px rgba(255,255,255,.018)}.recommendation-copy{padding:45px 52px}.section-kicker.light{color:#e5a58d}.recommendation h2{font-family:"Iowan Old Style",Baskerville,serif;font-size:5.6rem;line-height:.95;margin:18px 0 22px;font-weight:500}.recommendation .currency{font-size:2.2rem;vertical-align:top;margin-right:5px;color:#e5a58d}.recommendation small{font-family:"Avenir Next",Avenir,sans-serif;font-size:.85rem;text-transform:uppercase;letter-spacing:.13em;margin-left:8px;color:#c7d0ca}.recommendation-copy>p:last-child{max-width:520px;color:#cfd7d1}.recommendation-stats{display:grid;align-content:center;padding:34px 60px 34px 30px;z-index:1}.recommendation-stats div{padding:18px 0;border-bottom:1px solid rgba(255,255,255,.16)}.recommendation-stats div:last-child{border:0}.recommendation-stats span{display:block;color:#aebbb4;text-transform:uppercase;letter-spacing:.11em;font-size:.65rem}.recommendation-stats strong{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.45rem;font-weight:500}.confidence{display:inline-block!important;width:max-content;margin-top:5px;padding:5px 12px;border-radius:999px;font-family:"Avenir Next",Avenir,sans-serif!important;font-size:.78rem!important;text-transform:uppercase;letter-spacing:.11em}.confidence.high{background:#dbe9df;color:#264d3b}.confidence.medium{background:#f3e5bc;color:#624f17}.confidence.low{background:#eed1c8;color:#702e22}.evidence-grid{display:grid;grid-template-columns:repeat(4,1fr);margin:40px 54px 22px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.metric-card{padding:24px 20px 26px;border-right:1px solid var(--line);position:relative}.metric-card:last-child{border:0}.metric-index{position:absolute;right:14px;top:14px;color:#b7b2a8;font-family:monospace;font-size:.65rem}.metric-card p{color:var(--muted);font-size:.75rem;margin-bottom:14px}.metric-card strong{display:block;font-family:"Iowan Old Style",Baskerville,serif;font-size:2.5rem;font-weight:500;line-height:1}.metric-card sup{font-size:.9rem}.metric-card small{display:block;color:var(--muted);font-size:.68rem;margin-top:8px}.metric-card .rule-version{font-family:monospace;font-size:1.1rem;margin-top:9px}.report-section{padding:58px 54px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:60px;margin-bottom:30px}.section-heading h2{font-size:2.4rem;margin:0}.section-heading>p{max-width:410px;color:var(--muted);font-size:.82rem;margin:0}.table-wrap{overflow-x:auto;border-top:2px solid var(--ink)}table{width:100%;border-collapse:collapse;font-size:.82rem}th{text-align:left;text-transform:uppercase;letter-spacing:.1em;font-size:.61rem;color:var(--muted);padding:13px 9px;border-bottom:1px solid var(--line)}td{padding:18px 9px;border-bottom:1px solid var(--line);vertical-align:middle}.rank{font-family:monospace;color:var(--accent)}.address{font-weight:700;max-width:360px}.address a{color:inherit;text-decoration-color:#bd5b3d;text-underline-offset:3px}.reasons{font-size:.65rem;color:var(--muted);margin-top:5px}.configuration{white-space:nowrap}.rent{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.25rem}.score{display:inline-block;width:64px;height:4px;background:#ddd7cc;margin-right:8px;vertical-align:middle}.score span{display:block;height:100%;background:var(--accent)}td b{font-size:.72rem}.tenant{background:#e8e4da}.not-assessed,.tenant-rating{padding:7px 13px;border:1px solid var(--line);border-radius:999px;text-transform:uppercase;letter-spacing:.1em;font-size:.66rem}.empty-state{border-left:3px solid var(--gold);padding:12px 22px;max-width:720px}.empty-state p{color:var(--muted);margin:5px 0}.tenant-layout{display:grid;grid-template-columns:170px 1fr 1.2fr;gap:42px;align-items:center}.score-orbit{width:150px;height:150px;border:1px solid var(--accent);border-radius:50%;display:grid;place-content:center;text-align:center;box-shadow:inset 0 0 0 9px #e8e4da,inset 0 0 0 10px rgba(189,91,61,.25)}.score-orbit strong{font-family:"Iowan Old Style",Baskerville,serif;font-size:3.6rem;line-height:.8}.score-orbit span{color:var(--muted);font-size:.7rem;margin-top:8px}.component-list{list-style:none;margin:0;padding:0}.component-list li{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:.78rem}.tenant-reasons{border-left:1px solid var(--line);padding-left:35px}.tenant-reasons h3,.method-grid h3{font-family:"Iowan Old Style",Baskerville,serif;font-size:1.2rem}.tenant-reasons ul{padding-left:17px;color:var(--muted);font-size:.78rem}.methodology{border-top:1px solid var(--line)}.method-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px 55px}.method-grid div{border-top:1px solid var(--line);padding-top:18px}.method-grid p{font-size:.8rem;color:var(--muted);margin:0}footer{margin:10px 54px 0;padding:24px 0 34px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:30px;color:var(--muted);font-size:.64rem;text-transform:uppercase;letter-spacing:.08em}.reveal{animation:rise .6s ease both}.delay-1{animation-delay:.08s}.delay-2{animation-delay:.16s}.delay-3{animation-delay:.24s}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@media(max-width:820px){.report-shell{width:100%;margin:0}.masthead,.property-intro,.report-section{padding-left:24px;padding-right:24px}.masthead,.section-heading,footer{align-items:flex-start;flex-direction:column}.report-meta{margin-top:18px}.property-intro,.recommendation{grid-template-columns:1fr}.property-facts{margin-top:20px}.recommendation{margin:0 14px}.recommendation h2{font-size:4rem}.recommendation-copy{padding:38px 28px}.recommendation-stats{padding:0 28px 32px}.evidence-grid{grid-template-columns:1fr 1fr;margin:30px 24px}.metric-card:nth-child(2){border-right:0}.tenant-layout,.method-grid{grid-template-columns:1fr}.tenant-reasons{border-left:0;border-top:1px solid var(--line);padding:24px 0 0}}@media(prefers-reduced-motion:reduce){.reveal{animation:none}}@media print{html,body{background:#fff}.report-shell{width:100%;margin:0;box-shadow:none}.reveal{animation:none}.recommendation{-webkit-print-color-adjust:exact;print-color-adjust:exact}.report-section,.recommendation,.evidence-grid{break-inside:avoid}.table-wrap{overflow:visible}a{color:inherit;text-decoration:none}@page{size:A4;margin:12mm}}
"""

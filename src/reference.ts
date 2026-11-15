/**
 * Long-form reference text for the main tools, served as MCP resources
 * (`tracepass://reference/...`) instead of being repeated in every `tools/list`.
 *
 * A tool description rides in the model's context on every turn, so it carries
 * what is needed to pick the action and to stay safe (args, required fields,
 * confirmations, irreversible effects). Per-scheme identifier shapes, refusal
 * codes and response field lists live here and are read on demand. Static text,
 * no I/O.
 */

/** One reference document: the resource URI suffix, a title and the body. */
export interface ReferenceDoc {
  slug: string;
  title: string;
  description: string;
  text: string;
}

const PASSPORTS = `# tracepass_passports — reference

## Identifier schemes (EN 18219)
Passports are identified by one of five schemes. Battery passports (Battery Regulation Art. 77(3)) accept ONLY gs1 and iso15459.
- gs1 — { scheme:"gs1", gtin, serialNumber } — GS1 GTIN + serial; gtin is 8/12/13/14 digits, stored as GTIN-14.
- iso15459 — { scheme:"iso15459", issuingAgencyCode, primaryId, serial? } — ISO/IEC 15459; the server derives raw (IAC + primaryId + serial).
- iec61406 — { scheme:"iec61406", uri } — IEC 61406 Identification Link (https URI). Not valid for batteries.
- did — { scheme:"did", did, method } — W3C DID Core. Not valid for batteries.
- doi — { scheme:"doi", doi, granularity:"model"|"batch"|"item" } — ISO 26324 DOI, stored as bare 10.<registrant>/<suffix> (any https://doi.org/ or doi: prefix stripped on input; resolves as https://doi.org/<doi>); granularity REQUIRED per EN 18219 §5.6.2(b). Not valid for batteries.
The legacy top-level gtin + serialNumber pair is still accepted as a deprecated alias for scheme:"gs1".

## EU DPP Registry (battery passports)
The economic operator registers a passport itself, on the EU DPP Registry website under its own EU Login. TracePass prepares what the operator submits (prepare_registry_upi, prepare_registry_upload_file) and records what the operator reports back; it never submits to the Registry and never verifies the outcome. The Registry has two environments: acceptance (for testing, no legal effect) and production (the registration that counts). An acceptance result is recorded with record_acceptance_test; a production registration with record_registration in tracepass_passport_lifecycle.

- registry_readiness: { ready, findings[] } — whether the passport would pass the Registry's FORMAL submission gate: mandatory fields present, correct formatting, a resolvable public link, item-level granularity via a serial number, a well-formed commodity code where the category carries one, and, for EV, LMT and industrial (over 2 kWh) batteries, conformance to the Commission's battery data model the Registry validates against (REG-READY-SEMANTIC). This is the mechanical pre-submission check, NOT the substantive compliance verdict.
- prepare_registry_upi: returns { upi, preparedAt }, the unique product identifier the operator pastes into the Registry's online form. The first call fixes the UPI on the passport; later calls return the same one; each call records the preparation. Refusals: 404 passport_not_found; 409 not_a_battery | not_published | registered_in_production | registry_not_ready (findingDetails[]: { severity: critical|warning, why, fix?, target?, ruleId? }, blockers first; fix the critical ones and call again) | invalid_upi.
- prepare_registry_upload_file: returns { xml, filename, included: [{ id, upi }], excluded: [{ id, reason, details? }] }. Passports that would fail are left out and listed in \`excluded\`, because the Registry fails a whole file on one bad entry; reason ∈ not_found | not_battery | not_published | registered_in_production | registration_in_progress | readiness_blocked | invalid_upi | duplicate_upi | over_limit. Each included passport has its UPI fixed, as with prepare_registry_upi.
- record_acceptance_test: errorCode is the code the Registry showed for a failed test (≤100 chars). Returns { passport }. Refusals: 400 Validation failed; 404; 409 not_a_battery | not_published. It is not a registration and changes nothing else on the passport.

## create — lineage (battery only)
A repurposed, remanufactured or reused battery needs a NEW passport linked to the original(s) (Battery Regulation Art. 77(7)):
{ predecessors: [ { internalPassportId? | identifier?, trigger: preparation_for_reuse|preparation_for_repurposing|repurposing|remanufacturing } ] (≤10), noPredecessorReason? (only with an empty list, e.g. placed on the market before 18 Feb 2027) }.
The server derives batteryStatus from the triggers and links your own predecessor passports back. Immutable after create. Rule violations return 422 with the rule code (duplicate_predecessor, predecessor_not_found, status_trigger_mismatch, …).

## QR
symbology=datamatrix renders an ISO/IEC 16022 Data Matrix instead of a QR (EN 18220 permits both; same passport URL).

## Snapshots (EN 18221 change archive)
A snapshot is written on publish and after every change to a non-draft passport. list_snapshots returns, newest first, per snapshot: id, version, reason (published|field_edit|status_change|baseline|…), actor (when known), snapshotAt, contentHash, hashValid (re-verified on every read), restorable, fieldCount. With \`at\` it returns the single snapshot valid at that instant (full record plus validFrom/validUntil), which answers "what did this passport say on date D"; 404 before the first snapshot. get_snapshot returns the complete JSON-LD the passport asserted at that time, plus hash and hashValid. Both count 1 against the daily read budget.

## Condition flags
Reviewer-approved yes/no facts gating conditional legal duties. Battery flags: hasBMS, rechargeable, externalStorageOnly, isStationaryBess. Keys must be registered for the passport category. An approved flag makes specific fields required — a missing gated field is a hard publish block (conditional_missing). Writes are approved and audited; Idempotency-Key is supported.

## Measurements (battery, published only)
Over-life data pushed from the customer's own equipment (e.g. a BMS reporting stateOfHealth, numberOfFullEquivalentChargingCycles; the Annex XIII point 4 use-data keys). Every measurement is stored; the newest per field becomes the passport's current value and sets dynamicDataAsOf. externalId makes a measurement idempotent. A value may be at most 16 KB serialised. batteryStatus is NOT a measurement (400 invalid_field_key). A key the Regulation keeps off this battery category returns 422 field_not_applicable (e.g. stateOfCertifiedEnergy on an LMT battery). Metered against the plan's monthly measurement allowance, not the daily write budget: paid plans keep counting past it at no charge; Free stops at its allowance. Reading a passport is never metered. list_measurements pages with the returned nextCursor; latest_measurements returns the newest measurement per accepted key (null where none yet).
`;

const LIFECYCLE = `# tracepass_passport_lifecycle — reference

Every action here changes what the public sees or is a legal act. Confirm with the user before each call. Prefer suspend (reversible) to archive when a change might need undoing; a passport placed on the market cannot be suspended.

## EU DPP Registry
The economic operator registers a battery passport itself, on the EU DPP Registry website under its own EU Login. TracePass prepares what the operator submits (prepare_registry_upi / prepare_registry_upload_file in tracepass_passports) and records what the operator reports; it never submits to the Registry and never verifies the registration. The acceptance environment is for testing and has no legal effect (record_acceptance_test in tracepass_passports); only a registration in the production environment counts, and that is what record_registration records. The EU DPP Registry does not accept registrations through place_on_market. record_registration and undo_registration need a paid plan, and a connected app (OAuth) must act for an admin or owner.

## record_registration
Records that the operator has registered this passport in the PRODUCTION EU DPP Registry, as the operator states it; TracePass does not check it with the Registry. Effects: the passport is marked placed on the market (placeOnMarketStatus "placed", registrationMode "website"), the operator and facility party identifiers are locked (409 operator_locked on a later change), the backup copy is queued and the passport.placed_on_market webhook fires. placedOnMarketAt defaults to today; it may not be in the future or before the passport was first published. registrationId is the identifier the Registry gave, if any. Returns { passport }. Refusals: 400 Validation failed | invalid_date | date_in_future | date_before_publication | registration_id_too_long; 404; 409 not_a_battery | not_published | already_registered.

## undo_registration
production: removes a registration recorded with record_registration (one made through place_on_market is not undone here), so the passport is no longer marked placed and its operator identifiers unlock; a webhook already delivered is not recalled. acceptance: removes the recorded acceptance test. It changes nothing in the Registry itself. Returns { passport }. 404; 409 nothing_to_undo.

## place_on_market
Submits a registration to the EN 18222 registry API configured in the account's registry access settings. ASYNCHRONOUS: answers 202 { passport, passportId, status: "placing", dppId }; read the passport (get) to follow placeOnMarketStatus: placing → placed (placedOnMarketAt, registrationId) or rejected (registrationRejectionReason). To retry a rejected passport, fix the cause and call place_on_market again. Refusals are 409 with a code: not_a_battery | not_published | already_placed (placing or placed) | operator_id_missing (no economic-operator identifier on the account) | registry_not_configured (an admin sets registry access in the dashboard) | registry_host_not_allowed (TracePass does not send registrations to the configured registry address; check the registry URL) | registry_not_ready (findings[] lists what stands in the way — run registry_readiness for the structured findings). After placement the passport's party operatorIdentifier / facilityIdentifier are locked (409 operator_locked on a change).

## archive
reason is REQUIRED for battery passports (400 reason_required / invalid_reason without a valid one): recycled, never_placed (never placed on the market or put into service), or duplicate_or_error (a duplicate or erroneous record); optional for other categories. never_placed is refused (409 reason_contradicts_placement) on a passport placed on the market. A passport marked for deletion cannot be archived (409).
`;

const SCOPE = `# tracepass_scope — reference

## check
Ask whether a product type needs a DPP. Available on every plan, Free included. Counts against the per-company scope-answer cap (~100/day, 30/min burst), NOT the v1 read/write budget; 429 scope_answer_cap when the daily cap is spent. \`not_covered\` and \`needs_input\` are 200 results, not errors.
- category: battery | detergents | toys | construction | textile | steel | tyres | furniture | electronics | packaging | paints-coatings | jewelry | fmcg | vehicles | other.
- facts: namespace-prefixed keys from the loaded rules (e.g. battery.use, battery.capacityKWh). Unknown keys or wrong values return 400 invalid_input.
- role: manufacturer | importer | distributor | authorised_representative | fulfilment_service_provider. Selling under your own name = manufacturer with facts.ownBrand: true. Omit to list every role's duties.
- placedOnMarket: { date: 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY', precision?: 'day'|'month'|'year' } or null.
- contains: array (≤5) of component queries, e.g. a battery inside a toy: [ { label?, facts? } ].
- locale: en | bg | de | it (default: from Accept-Language header, else en).

## catalogue_report
Catalogue-wide scope report, one row per product. Growth plan or above; 403 plan_upgrade_required below it. Counts 1 against the daily read budget per page. classification filter: missing | draft_only | published_incomplete | published | not_required | open_questions | not_covered. Response: { run, running, totals, items: [{ productId, passportIds, gtin, category, summary, classification, changedAt }], nextCursor, disclaimer }. Full answer for one product: call check with that productId.

## catalogue_run / catalogue_run_status
catalogue_run starts a refresh run (also runs nightly); returns 202 { runId, status }; poll with catalogue_run_status (queued | running | done | failed, plus result counts). Growth plan. 409 run_in_progress if already active; 429 run_cooldown with retryAfter within 10 minutes of a finished run.
`;

const PARTIES = `# tracepass_passport_parties — reference

Identifier rules (EN 18219 §6.2–6.5): a party needs at least one of \`gln\`, \`legacyOperatorId\`, or \`operatorIdentifier\`. If both \`gln\` and \`operatorIdentifier\` (scheme gln) are provided they must agree — a mismatch returns 400. An operatorIdentifier of scheme gln also fills the top-level \`gln\` field; facilityIdentifier never does. Typed identifiers (operatorIdentifier / facilityIdentifier) are not set by AI extraction or CSV import.

operatorIdentifier schemes:
- iso6523 — { scheme:"iso6523", icd:"<4 digits>", value } — ICD 0199 = LEI (ISO 17442), 0088 = GLN, 0060 = DUNS.
- gln — { scheme:"gln", gln:"<13 digits>" } — also fills top-level \`gln\`.
- did — { scheme:"did", did:"did:<method>:<id>" } — syntax-checked only (EN 18219 §6.4.2(b)).
- doi — { scheme:"doi", doi:"10.<registrant>/<suffix>" } — doi:/https://doi.org/ prefix accepted and stripped.

facilityIdentifier schemes: same four; the gln variant also accepts optional \`extension\` (GS1 SGLN sub-location).

After a battery passport is placed on the market, changing a stored operatorIdentifier or facilityIdentifier returns 409 operator_locked; to correct a locked identifier the passport is marked for deletion and a new one created.

set: tradeName, postalAddress and email are shown on the public passport; for a battery importer they are its Battery Regulation Art. 41(3) details.
`;

const TEMPLATES = `# tracepass_templates — reference

## Battery required-ness
Resolve in this order. 1. SCOPE FIRST: only EV, LMT and industrial_gt_2kwh batteries owe a passport (Art. 77(1), Reg (EU) 2023/1542); for portable, SLI or industrial_lte_2kwh NO field is required. 2. Then \`requiredBy[batteryCategory]\` where the field carries that map (required | conditional | notApplicable). \`conditional\` means owed only when a fact holds (a commercial warranty offered, a BMS present, the battery in service); an approved condition flag can make it required. Annex XIII 4(d) use data (charging cycles, negative events, temperature history, state of charge) is expected once the battery is in service and never blocks publishing. 3. Then fall back to \`required\`.
The map is keyed ONLY by the three in-scope categories, so skipping step 1 falls through to \`required\` and invents an obligation the Regulation does not impose. EV and LMT report state-of-health through MUTUALLY EXCLUSIVE field sets: an EV battery leaves the remaining-capacity cluster empty and an LMT battery leaves stateOfCertifiedEnergy empty, so no single battery fills every field.
`;

/** Every reference document, keyed by the slug in \`tracepass://reference/<slug>\`. */
export const REFERENCE_DOCS: readonly ReferenceDoc[] = [
  {
    slug: "passports",
    title: "tracepass_passports reference",
    description:
      "Identifier scheme shapes, EU DPP Registry action detail and refusal codes, lineage, snapshots, condition flags and measurements for tracepass_passports.",
    text: PASSPORTS,
  },
  {
    slug: "lifecycle",
    title: "tracepass_passport_lifecycle reference",
    description:
      "Effects, refusal codes and the EU DPP Registry model for record_registration, undo_registration, place_on_market and archive.",
    text: LIFECYCLE,
  },
  {
    slug: "scope",
    title: "tracepass_scope reference",
    description:
      "Argument values, caps, plan gates and response shapes for the scope check and catalogue actions.",
    text: SCOPE,
  },
  {
    slug: "templates",
    title: "tracepass_templates reference",
    description:
      "Battery required-ness rules: scope first, then requiredBy, conditional fields, use data.",
    text: TEMPLATES,
  },
  {
    slug: "parties",
    title: "tracepass_passport_parties reference",
    description: "Operator and facility identifier schemes and the identifier rules for parties.",
    text: PARTIES,
  },
];

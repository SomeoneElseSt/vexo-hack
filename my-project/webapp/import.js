// Import an existing record (FHIR Bundle, or this app's own JSON export) into
// the sealed log. Everything is sealed in the browser with the device key, so
// the VM receives only ciphertext — same path as a freshly logged event.
//
//   window.vexoImport.importFile(File) -> {imported, skipped, errors}
//   window.vexoImport.parse(text)      -> [{kind, record}]  (no network)
'use strict';

(function () {
  const KINDS = ['Observation', 'Encounter', 'Communication',
                 'MedicationRequest', 'MedicationAdministration'];
  const FHIR_TO_KIND = Object.fromEntries(KINDS.map((k) => [k, k]));

  const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';

  function observationFromFhir(r) {
    return {
      schema_version: '0.1',
      id: r.id || 'evt-import-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
      ts: r.effectiveDateTime || null,
      source: 'import',
      verbatim_quote: r.note?.[0]?.text || null,
      body_location: r.bodySite?.text || null,
      quality: r.code?.text || null,
      severity: r.component?.[0]?.valueInteger ?? null,
      activity: null,
      excerpt_model: null,
    };
  }

  function fromFhir(resource) {
    const type = resource?.resourceType;
    const kind = FHIR_TO_KIND[type];
    if (!kind) return null;
    const id = resource.id || kind.toLowerCase() + '-import-' + Date.now();
    if (kind === 'Observation') return { kind, record: observationFromFhir(resource) };
    if (kind === 'Encounter') {
      return { kind, record: {
        schema_version: '0.1', id, ts: resource.period?.start || null,
        clinician: resource.participant?.[0]?.individual?.display || null,
        specialty: resource.serviceType?.text || null,
        kind: resource.class?.display || resource.class?.code || null,
        reason: resource.reasonCode?.[0]?.text || null,
        summary: resource.text?.div?.replace(/<[^>]*>/g, ' ').trim() || null,
        instructions: [], follow_up: null, medication_ids: [], related_event_ids: [],
        source: 'import',
      } };
    }
    if (kind === 'Communication') {
      return { kind, record: {
        schema_version: '0.1', id, ts: resource.sent || null,
        thread: resource.encounter?.reference?.replace('Encounter/', '') || 'general',
        from: resource.sender ? 'clinician' : 'patient',
        to: resource.sender ? 'patient' : 'clinician',
        sender: resource.sender?.display || 'Imported',
        body: resource.payload?.[0]?.contentString || null,
        priority: resource.priority || null, action: null, related_event_ids: [],
      } };
    }
    if (kind === 'MedicationRequest') {
      return { kind, record: {
        schema_version: '0.1', id, ts: resource.authoredOn || null,
        name: resource.medicationCodeableConcept?.text || null,
        dose: resource.dosageInstruction?.[0]?.text || null,
        times: resource.dosageInstruction?.[0]?.timing?.repeat?.timeOfDay || [],
        instructions: resource.dosageInstruction?.[0]?.text || null,
        prescribed_by: resource.requester?.display || null,
        visit_id: resource.encounter?.reference?.replace('Encounter/', '') || null,
        start: resource.authoredOn?.slice(0, 10) || null, end: null,
        confirmed_at: null, confirmed_by: null,
      } };
    }
    return { kind, record: {
      schema_version: '0.1', id, ts: resource.effectiveDateTime || null,
      taken_at: resource.effectiveDateTime || null,
      medication_id: resource.medicationReference?.reference?.replace('MedicationRequest/', '') || null,
      medication_name: resource.medicationCodeableConcept?.text || null,
      dose_taken: resource.dosage?.text || null, method: 'import',
      verbatim_quote: null,
    } };
  }

  // this app's own export: an array of plain contract records
  function fromOwnExport(list) {
    const out = [];
    for (const rec of list) {
      let kind = 'Observation';
      if (rec.medication_ids || rec.clinician || rec.summary) kind = 'Encounter';
      else if (rec.thread || rec.sender || rec.body) kind = 'Communication';
      else if (rec.name && rec.dose) kind = 'MedicationRequest';
      else if (rec.taken_at || rec.medication_name) kind = 'MedicationAdministration';
      out.push({ kind, record: rec });
    }
    return out;
  }

  function parse(text) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return fromOwnExport(data);
    const resources = data.resourceType === 'Bundle'
      ? (data.entry || []).map((e) => e.resource).filter(Boolean)
      : [data];
    const out = [];
    for (const r of resources) {
      const mapped = fromFhir(r);
      if (mapped) out.push(mapped);   // unknown resource types are dropped, not guessed
    }
    return out;
  }

  async function importFile(file) {
    const auth = window.vexoAuth;
    if (!auth || !auth.isUnlocked()) throw new Error('unlock your records first');
    const records = parse(await file.text());
    const result = { imported: 0, skipped: 0, errors: [] };
    for (const { kind, record } of records) {
      try {
        // sealEvent fills id and ts when missing and returns the vault body
        const body = await auth.sealEvent({ ...record, source: record.source || 'import' });
        const res = await fetch('/' + kind, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth.headers() },
          body: JSON.stringify(body),
        });
        if (res.status === 401 || res.status === 403) {
          result.skipped += 1;
          result.errors.push(`${kind} ${record.id}: not accepted (${res.status})`);
          continue;
        }
        if (!res.ok) throw new Error(`${kind} ${record.id}: HTTP ${res.status}`);
        result.imported += 1;
      } catch (err) {
        result.skipped += 1;
        result.errors.push(String(err.message || err));
      }
    }
    window.dispatchEvent(new Event('vexo-imported'));
    return result;
  }

  window.vexoImport = { parse, importFile, KINDS };
})();

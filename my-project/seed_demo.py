"""Demo data: two weeks of a cough and fever, a visit, its medicines and doses.

Everything is fake and dated relative to today, so the demo always looks current.
Each record is sealed with this device's key, exactly like the bridge does, so it
works against a local records server or the VM vault.

Usage:
    python my-project/seed_demo.py [--records http://localhost:8766] [--key PATH]

It adds records (ids start with "demo-"); it does not delete anything. To start
clean, stop the records server and remove its data/records.db first.
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import device_crypto as dc  # noqa: E402

W, X = "faster-whisper-small", "gemma3:12b"
TODAY = dt.date.today()
OFFSET = dt.datetime.now().astimezone().strftime("%z")
OFFSET = OFFSET[:3] + ":" + OFFSET[3:]


def ts(days_ago: int, hh: int, mm: int) -> str:
    d = TODAY - dt.timedelta(days=days_ago)
    return f"{d.isoformat()}T{hh:02d}:{mm:02d}:00{OFFSET}"


def day(days_from_now: int) -> str:
    return (TODAY + dt.timedelta(days=days_from_now)).isoformat()


# days ago, hh, mm, source, body_location, quality, severity, activity, what the patient said
SYMPTOMS = [
    (13, 7, 40, "band", "throat", "scratchy", 3, "waking up", "Scratchy throat this morning, maybe a three."),
    (12, 15, 20, "band", None, "fever", 5, "at work", "Feeling hot and shivery, thermometer says 38.4, I'd say a five."),
    (12, 21, 5, "band", "head", "aching", 4, "lying down", "Headache behind my forehead, a four."),
    (11, 23, 30, "band", "chest", "dry cough", 4, "trying to sleep", "Dry cough keeping me up, about a four."),
    (10, 6, 50, "band", None, "fever", 6, "waking up", "Woke up with chills, 38.9 on the thermometer, a six."),
    (10, 13, 15, "manual", None, "fatigue", None, "after a shower", "Completely wiped out after a shower."),
    (9, 19, 45, "band", "chest", "coughing fits", 6, "talking", "Coughing fits, my chest hurts when I cough, a six."),
    (8, 8, 30, "band", "chest", "short of breath", 5, "climbing stairs", "Out of breath on the stairs, a five."),
    (7, 14, 10, "band", None, "fever", 5, "on the couch", "Fever back up to 38.2, a five."),
    (6, 9, 0, "band", "chest", "wet cough", 5, "morning", "Cough is wet now, yellow phlegm, a five."),
    (5, 18, 25, "band", "throat", "sore", 3, "after coughing", "Throat sore from all the coughing, a three."),
    (4, 22, 40, "band", "chest", "tightness", 6, "coughing", "Chest feels tight when I cough, about a six."),
    (2, 10, 15, "band", "chest", "cough", 4, "morning", "Cough a bit better today, a four."),
    (1, 20, 0, "band", None, "low fever", 2, "evening", "Low fever, 37.6, a two."),
    (0, 8, 20, "band", "chest", "cough", 3, "waking up", "Still coughing in the morning, a three."),
    (0, 13, 40, "band", "abdomen", "nausea", 2, "after the antibiotic", "Little queasy after the antibiotic, a two."),
]

VISITS = [
    {"id": "demo-enc-0", "ts": ts(45, 10, 0), "clinician": "Dr. Maya Chen", "specialty": "Family Medicine", "kind": "video",
     "reason": "Annual check-up", "summary": "Routine check-up. Blood pressure 122/78. Vaccines up to date.",
     "instructions": ["Flu shot this autumn"], "follow_up": None, "source": "visit recording · local models"},
    {"id": "demo-enc-1", "ts": ts(3, 11, 30), "clinician": "Dr. Maya Chen", "specialty": "Family Medicine", "kind": "in person",
     "reason": "Cough and fever for ten days",
     "summary": "You have had a fever and a cough for about ten days, and the cough is now wet. Your temperature today was 38.1 and you had some crackles in the right lower lung. We are treating this as a chest infection with an antibiotic and ordering a chest X-ray.",
     "instructions": ["Take the antibiotic three times a day for 7 days, even if you feel better",
                      "Rest and drink plenty of fluids",
                      "Acetaminophen for fever, no more than every 6 hours",
                      "Go to urgent care if you are short of breath at rest or the fever goes above 39.5",
                      "Keep logging your cough and temperature on the band"],
     "tests_ordered": ["Chest X-ray"],
     "follow_up": day(7), "medication_ids": ["demo-med-1", "demo-med-2", "demo-med-3"],
     "related_event_ids": [f"demo-evt-{i}" for i in (4, 5, 7, 8, 10, 12)],
     "approved_at": ts(3, 12, 5), "approved_by": "Dr. Maya Chen", "status": "final",
     "source": "visit recording · local models"},
    {"id": "demo-enc-2", "ts": f"{day(1)}T10:00:00{OFFSET}", "clinician": "Radiology", "specialty": "Imaging", "kind": "in person",
     "reason": "Chest X-ray", "summary": None, "instructions": [], "follow_up": None, "source": "scheduled"},
    # a recorded follow-up call waiting for the clinician: the backup for the live visit demo
    {"id": "demo-enc-3", "ts": ts(0, 16, 30), "start": ts(0, 16, 30), "end": ts(0, 16, 42), "status": "draft", "kind": "video",
     "clinician": "Dr. Maya Chen", "specialty": "Family Medicine", "reason": "Follow-up: cough and fever",
     "note": {"subjective": "Day 3 of amoxicillin. Fever down to 37.6 last night. Cough improving, still worse in the morning. Mild nausea after doses.",
              "objective": "Temperature 37.4. Breathing comfortably. Fewer crackles in the right lower lung.",
              "assessment": None,
              "plan": "Continue amoxicillin to finish the 7 days. Take it with food. Chest X-ray tomorrow as planned."},
     "summary": "You are getting better: the fever is coming down and the cough is easing. Keep taking the antibiotic with food until it is finished, and go to your chest X-ray tomorrow.",
     "instructions": ["Take the antibiotic with food", "Finish all 7 days"],
     "tests_ordered": ["Chest X-ray"], "follow_up_text": "Call back if the fever returns", "follow_up": None,
     "medications": [], "medication_ids": [], "related_event_ids": [],
     "transcript": "I'm with the doctor.\nHi, it's Dr. Chen. How are you feeling on the antibiotic?\nBetter. The fever was 37.6 last night and the cough is easing, but it's still bad in the mornings. I feel a bit sick after the pills.\nTake it with food, that usually helps. Your temperature is 37.4 and your breathing sounds better, fewer crackles on the right.\nKeep going until the seven days are done, and still get the chest X-ray tomorrow.\nCall back if the fever comes back.\nThanks, the meeting is done.",
     "transcript_model": W, "note_model": X, "source": "visit recording · local models"},
]

# id, name, dose, times, instructions, confirmed (days ago) or None
MEDICINES = [
    ("demo-med-1", "Amoxicillin", "500 mg capsule", ["08:00", "14:00", "21:00"], "for 7 days, with food", 3),
    ("demo-med-2", "Acetaminophen", "500 mg tablet", [], "as needed for fever, at most every 6 hours", 3),
    ("demo-med-3", "Benzonatate", "100 mg capsule", [], "up to three times a day for cough", None),
]

# id, medicine id, name, dose, days ago, hh, mm, how, what was said
DOSES = [
    ("demo-adm-1", "demo-med-1", "Amoxicillin", "500 mg capsule", 2, 8, 5, "voice", "I took medicine one"),
    ("demo-adm-2", "demo-med-1", "Amoxicillin", "500 mg capsule", 1, 14, 10, "manual", None),
    ("demo-adm-3", "demo-med-2", "Acetaminophen", "500 mg tablet", 1, 22, 0, "voice", "Took medicine two for the fever"),
    ("demo-adm-4", "demo-med-1", "Amoxicillin", "500 mg capsule", 0, 8, 10, "voice", "Medicine one taken"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", default="http://localhost:8766")
    ap.add_argument("--key", default=None, help="device key file (default: the bridge's)")
    args = ap.parse_args()
    secret = dc.load_or_create_secret(Path(args.key)) if args.key else dc.load_or_create_secret()
    device = dc.device_id(secret)
    session = requests.Session()

    def post(kind: str, record: dict) -> None:
        record.setdefault("schema_version", "0.1")
        body = {"event": {"id": record["id"], "device": device},
                "sealed": dc.seal(secret, json.dumps(record).encode())}
        r = session.post(f"{args.records}/{kind}", json=body, timeout=20,
                         headers={"X-Device-Auth": dc.auth_token(secret)})
        r.raise_for_status()

    for i, (d, h, m, src, loc, q, sev, act, quote) in enumerate(SYMPTOMS, 1):
        post("Observation", {"id": f"demo-evt-{i}", "ts": ts(d, h, m), "source": src,
                             "audio_seconds": 0 if src == "manual" else round(3 + (i % 5) * 0.9, 1),
                             "body_location": loc, "quality": q, "severity": sev, "activity": act,
                             "verbatim_quote": quote,
                             "transcript_model": None if src == "manual" else W,
                             "extract_model": None if src == "manual" else X})
    for v in VISITS:
        post("Encounter", {"medication_ids": [], "related_event_ids": [], **v})
    for mid, name, dose, times, ins, confirmed in MEDICINES:
        post("MedicationRequest", {"id": mid, "ts": ts(3, 11, 50), "name": name, "dose": dose, "times": times,
                                   "instructions": ins, "prescribed_by": "Dr. Maya Chen", "visit_id": "demo-enc-1",
                                   "start": day(-3), "end": day(4) if mid == "demo-med-1" else None,
                                   "confirmed_at": ts(confirmed, 12, 30) if confirmed is not None else None,
                                   "confirmed_by": "patient" if confirmed is not None else None})
    for aid, mid, name, dose, d, h, m, how, quote in DOSES:
        t = ts(d, h, m)
        post("MedicationAdministration", {"id": aid, "ts": t, "taken_at": t, "medication_id": mid,
                                          "medication_name": name, "dose_taken": dose, "method": how,
                                          "verbatim_quote": quote})
    print(f"seeded {len(SYMPTOMS)} symptoms, {len(VISITS)} visits, {len(MEDICINES)} medicines, "
          f"{len(DOSES)} doses into {args.records}")


if __name__ == "__main__":
    main()

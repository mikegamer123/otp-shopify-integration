# Questions to send OTP banka / iPay

Send this list the moment you have a contact — ideally with the contract paperwork,
before the sandbox credentials arrive. Bank integration teams answer in batches with
long gaps, so asking everything up front can save a week or two of round-trips.

Each answer maps to one clearly-marked `SPEC:` comment in `lib/otp-adapter.js`.
Nothing else in the codebase needs to change.

Copy from the line below into an email.

---

Poštovani,

Integrišemo Vaš e-commerce payment gateway sa našom Shopify prodavnicom i pripremamo
implementaciju unapred. Molimo Vas za sledeće tehničke informacije (ili link ka
razvojnoj dokumentaciji):

**1. Endpoints**
- URL hosted payment stranice za test (sandbox) okruženje?
- URL za produkciju?
- Da li se korisnik preusmerava GET redirect-om sa query parametrima, ili je
  neophodan HTTP POST forme sa skrivenim poljima?

**2. Polja u zahtevu**
- Tačna lista obaveznih i opcionih polja, sa tačnim nazivima (case-sensitive).
- Format iznosa: `1234.56`, `1234,56`, ili u parama bez separatora (`123456`)?
- Format valute: ISO alfa (`RSD`) ili numerički (`941`)?
- Maksimalna dužina polja za referencu porudžbine, i dozvoljeni karakteri?

**3. Potpis (signature / hash)**
- Koja polja ulaze u potpis i **kojim tačnim redosledom**?
- Koji separator se koristi između polja (npr. `|`, ili bez separatora)?
- Algoritam: HMAC-SHA256, SHA-512, nešto drugo?
- Enkodiranje rezultata: hex ili base64?
- Da li se tajni ključ koristi kao HMAC ključ, ili se dodaje na kraj stringa pre heširanja?
- Da li postoji primer (test vektor): ulazni podaci + očekivani potpis? **Ovo nam
  najviše pomaže** — omogućava da verifikujemo implementaciju pre pristupa sandboxu.

**4. Notifikacija o rezultatu (webhook / callback)**
- Da li šaljete server-to-server notifikaciju nezavisno od preusmeravanja browsera?
  (Za nas je to ključno — ne smemo da se oslanjamo na povratak korisnika u browser.)
- Na koji URL i kojom metodom? Content-Type: JSON ili `application/x-www-form-urlencoded`?
- Tačan naziv i moguće vrednosti polja koje označava uspeh/neuspeh.
- Kako se potpisuje notifikacija (ista polja/redosled kao gore, ili drugačije)?
- Politika ponovnog slanja: koliko puta i u kom intervalu pokušavate ako ne dobijete
  HTTP 200? Koji HTTP status očekujete kao potvrdu?
- **Koliko dugo čekate na odgovor pre nego što notifikaciju smatrate neuspelom
  (connect timeout i read timeout, u sekundama)?** I da li ponavljate slanje i kada
  istekne vreme, ili samo kada dobijete grešku sa statusom? — Ovo nam je potrebno
  da bismo znali koliko servera sme da "spava": ako notifikacija stigne dok se
  instanca budi, odgovor može da kasni 30-60 sekundi.
- Sa kojih IP adresa stižu notifikacije (za whitelisting)?

**4b. Prikaz stavki na stranici za plaćanje (basket / korpa)**
- Da li vaša hostovana stranica može da prikaže **specifikaciju stavki** (naziv
  artikla, količina, jedinična cena, iznos po stavci) pored ukupnog iznosa?
- Ako može: koji je tačan format parametra? (JSON, ponovljeni indeksirani
  parametri tipa `item[0].name`, ili string sa separatorom?) Koliko stavki
  maksimalno i koliko karaktera sme da bude?
- **Da li je taj parametar obuhvaćen potpisom?** — Ovo nam je ključno. Ako
  stavke NISU potpisane, kupac može da izmeni parametar u URL-u i vidi lažne
  cene na stranici banke dok se naplaćuje tačan (potpisan) iznos. U tom slučaju
  radije ne bismo slali stavke uopšte.
- Ako se šalje GET redirekcijom, koje je ograničenje dužine URL-a? (Duža korpa
  nam može premašiti limit — da li onda moramo na POST?)

**5. Testiranje**
- Test kartice (brojevi, datum isteka, CVV) za scenarije: uspešna transakcija,
  odbijena transakcija, 3-D Secure izazov, timeout.
- Da li sandbox zahteva whitelisting našeg callback URL-a unapred?

**6. Operativno**
- Podrška za 3-D Secure 2 — da li je automatska ili zahteva dodatna polja?
- Da li je podržan refund/void preko API-ja, i kojim pozivom?
- Rok važenja transakcije (koliko dugo je payment link validan)?
- Da li podržavate delimični povraćaj sredstava?

Hvala unapred,

---

## Where each answer goes

| Question | File | What to change |
|---|---|---|
| Endpoints (1) | `.env` | `OTP_GATEWAY_URL` |
| Redirect method (1) | `lib/otp-adapter.js` | `method` in `buildPaymentRequest` |
| Field names (2) | `lib/otp-adapter.js` | the `fields` object |
| Amount format (2) | `lib/otp-adapter.js` | `formatAmount` |
| Currency format (2) | `lib/otp-adapter.js` | `formatCurrency` |
| Signature fields + order (3) | `lib/otp-adapter.js` | `REQUEST_SIGNATURE_FIELDS`, `CALLBACK_SIGNATURE_FIELDS` |
| Separator + algorithm (3) | `lib/otp-adapter.js` | `SEPARATOR`, `sign()` |
| Test vector (3) | `scripts/smoke.js` | add an assertion that our `_sign` reproduces their expected value |
| Callback content-type (4) | already handled | server parses JSON and form-encoded |
| Status vocabulary (4) | `lib/otp-adapter.js` | `STATUS_MAP` |
| Retry policy (4) | already handled | webhook is idempotent and returns 200/4xx/5xx correctly |
| IP whitelist (4) | `server.js` | add an allowlist check in the webhook handler |
| Test cards (5) | `SETUP.md` | record them in the Phase 4 checklist |

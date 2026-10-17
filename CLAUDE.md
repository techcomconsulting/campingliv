# Campingliv – anteckningar för Claude

Ägare: Martin. Svara alltid på svenska, kort och enkelt (han är lite dyslektiker och kan inte programmera).
Martin ska bara behöva komma med idéer – Claude gör allt arbete, testar och publicerar.

## Teknik
- Ingen byggprocess: ren HTML/CSS/JS-moduler i `public/`. Firebase SDK laddas från gstatic (v10.12.2).
- Firebase-projekt: `campingliv-a2e96` (Auth e-post/lösenord + Firestore, eur3).
- Hosting: Firebase Hosting → https://campingliv-a2e96.web.app
- Push till `main` → `.github/workflows/deploy.yml` → `scripts/deploy.py` publicerar
  auth-inställning, databas, regler, index och hosting. Kräver secret `FIREBASE_SA` (roll Firebase Admin).
- Loggar kan inte läsas härifrån. Läs fel via annotations: gh api repos/techcomconsulting/campingliv/check-runs/<job-id>/annotations
- Starta körning: gh api -X POST repos/techcomconsulting/campingliv/actions/workflows/deploy.yml/dispatches -f ref=main
- Containern når inte web.app/gstatic; live-test görs av Martin.
- Synlighet (public/friends/private) verkställs i `firestore.rules`. Vänskap = `users/{uid}/friends/{fid}`.

## Planerad ordning
1 konto/profil ✅ 2 flöde/gilla/kommentera ✅ 3 vänner/synlighet ✅
4 bilder (Cloudflare R2) 5 karta (OpenStreetMap) 6 resor + kostnader 7 incheckning
8 reseanimation 9 API /api/v1 för campingar 10 admin

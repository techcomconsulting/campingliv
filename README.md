# Campingliv

Social app för camping, husbil och roadtrips.
Appen finns på **https://campingliv-a2e96.web.app**

## Så fungerar det
- All kod ligger här på GitHub.
- Varje ändring publiceras automatiskt till Firebase (se fliken **Actions**).
- Det gäller appen, säkerhetsreglerna och databasindex.

## Engångsinställning (redan gjord en gång, behövs inte igen)
Hemligheten `FIREBASE_SA` är en nyckel för ett servicekonto med rollen **Firebase Admin**
i Firebase-projektet `campingliv-a2e96`.

## Mappar
- `public/` – själva appen
- `firestore.rules` – säkerhetsregler (vem får se vad)
- `firestore.indexes.json` – databasindex
- `scripts/deploy.py` – publiceringen

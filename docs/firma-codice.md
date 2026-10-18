# Firma del codice (Windows)

> **Non attiva.** La richiesta a SignPath Foundation è stata rifiutata: gli installer escono non firmati.
> La CI resta pronta e si attiva da sola se in futuro viene aggiunto il secret `SIGNPATH_API_TOKEN`.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- **Cosa viene firmato:** solo l'installer Windows `Segueo-<versione>-win-x64.msi` e il programma `Segueo.exe`
  al suo interno, compilati da GitHub Actions (`.github/workflows/release.yml` e `beta.yml`) a partire dal codice
  di questo repository. Nessun file viene firmato a mano o fuori dalla CI.
- **Committer e revisori:** [basoxxx](https://github.com/basoxxx) (proprietario del repository).
- **Approvatori:** [basoxxx](https://github.com/basoxxx). Ogni firma di rilascio va approvata a mano su SignPath.
- **Privacy:** Segueo non trasmette alcuna informazione a sistemi in rete se non su richiesta esplicita
  dell'utente o di chi lo installa/usa. Le eccezioni sono dichiarate nell'app: il controllo degli aggiornamenti
  (GitHub Releases), la ricerca online dei brani richiesti dal pubblico e il download dei modelli AI.

## Configurazione (una volta sola)

1. Richiedi la firma gratuita su <https://signpath.org/apply> indicando questo repository.
2. Una volta approvato, nel progetto SignPath:
   - collega il repository GitHub come *Trusted Build System* (GitHub.com);
   - crea l'*artifact configuration* `msi` con il contenuto qui sotto;
   - usa la *signing policy* `release-signing` assegnata dalla Foundation.
3. Su GitHub → Settings → Secrets and variables → Actions:
   - **secret** `SIGNPATH_API_TOKEN`: token di un utente CI di SignPath (ruolo *Submitter* sulla policy);
   - **variabile** `SIGNPATH_ORGANIZATION_ID`: l'ID dell'organizzazione SignPath;
   - facoltative, se gli slug sono diversi: `SIGNPATH_PROJECT_SLUG` (default `Virtual-Dj-Ai`),
     `SIGNPATH_SIGNING_POLICY_SLUG` (default `release-signing`), `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` (default `msi`).

Finché il secret non esiste, la CI produce l'MSI non firmato come prima. Con il secret, ogni rilascio aspetta
fino a un'ora l'approvazione su app.signpath.io, poi pubblica l'MSI firmato e controlla che la firma sia valida.

### Artifact configuration `msi`

L'artifact caricato da GitHub è uno zip che contiene l'MSI: si firma prima `Segueo.exe` dentro l'MSI, poi l'MSI.

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <msi-file path="Segueo-*-win-x64.msi">
      <pe-file path="Segueo.exe">
        <authenticode-sign />
      </pe-file>
      <authenticode-sign />
    </msi-file>
  </zip-file>
</artifact-configuration>
```

## SmartScreen

La firma toglie l'avviso «autore sconosciuto»: Windows mostra *SignPath Foundation* come editore. Microsoft
SmartScreen però si basa anche sulla reputazione: nei primi giorni dopo un certificato nuovo può ancora comparire
«Windows ha protetto il PC» finché l'installer non è stato scaricato abbastanza volte. In quel caso:
**Ulteriori informazioni → Esegui comunque**.

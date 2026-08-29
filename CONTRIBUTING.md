# Contribuer

Ce dépôt est maintenu par une petite équipe. Les contributions sont les
bienvenues, à condition qu'elles restent faciles à relire.

## Avant de coder

Pour autre chose qu'une correction évidente (typo, lien mort, cas de test),
**ouvrez d'abord une issue** décrivant le problème et la piste envisagée. Cela
évite d'écrire du code qui sera refusé pour une raison de périmètre.

## Lancer les tests

Node ≥ 18. Le connecteur dépend du SDK par chemin local, donc **le SDK doit
être compilé en premier** — sinon la vérification de types du connecteur échoue.

```bash
cd sdk-node
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # produit dist/, requis par le connecteur
npm test            # compile les tests puis node --test

cd ../stripe-connector
npm ci
npm run typecheck
npm run build
npm test
```

La CI (`.github/workflows/ci.yml`) exécute exactement cette séquence sur Node 20
et 22, plus `npm audit`. Une PR dont la CI est rouge n'est pas relue.

## Ce que nous acceptons

- Les corrections de bugs, avec un test qui échoue avant le correctif.
- L'alignement du SDK sur le contrat réel de l'API (types, codes d'erreur,
  comportements de retry) — citez la section de l'OpenAPI concernée.
- Les tests supplémentaires et les corrections de documentation.
- Un nouveau connecteur de référence : discutons-en en issue d'abord, car il
  faudra le maintenir.

## Ce que nous n'acceptons pas

- **Toute donnée réelle** dans le code, les tests ou la description de la PR :
  clé API, secret de webhook, SIRET, e-mail ou facture d'un vrai client.
  Utilisez des valeurs factices.
- Des tests qui appellent l'API de production. Les tests doivent tourner hors
  ligne, sans clé.
- Une nouvelle dépendance d'exécution : les deux paquets tournent sur la
  bibliothèque standard de Node, c'est délibéré. Une dépendance de
  développement se justifie en issue.
- Le reformatage massif, le renommage de confort, ou un changement mêlant
  refonte et correction : une PR = un sujet.
- Les changements de `version`, de `publishConfig` ou toute publication npm :
  c'est ITICK qui décide des versions publiées.
- Du code généré et non relu, sans test et sans explication de ce qu'il corrige.

## Forme des contributions

Commits et PR en français ou en anglais, peu importe : ce qui compte est que le
message dise **ce que le changement corrige**, pas seulement ce qu'il touche.
Le gabarit de PR liste ce que la relecture attend.

## Licence des contributions

En proposant une contribution (issue, PR, extrait de code), vous acceptez
qu'elle soit distribuée sous la **licence MIT** de ce dépôt (voir
[LICENSE](LICENSE)) et vous certifiez avoir le droit de la soumettre — que ce
soit votre travail, ou du code que vous êtes autorisé à contribuer sous cette
licence.

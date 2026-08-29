# Publication du dépôt — réglages à appliquer à la main

Cette page liste ce qui **ne peut pas être versionné** : les réglages GitHub à
cocher au moment de créer `itick-app/itick-integrations`. Elle est destinée à
Adam ; elle peut être supprimée du dépôt public une fois la publication faite.

État au 2026-08-29 : le dépôt local n'a **aucun remote**, rien n'a été poussé.

---

## 1. Avant de créer le dépôt

- [ ] Relire l'historique complet une dernière fois : `git log -p | less`.
      Passer public rend **tous les commits** visibles, pas seulement le
      dernier état. Vérification déjà faite le 2026-08-29 : aucune clé, aucun
      secret, aucune adresse réelle dans les 6 commits (seules des valeurs
      factices — `itick_sandbox_xxx`, `whsec_xxx`, `client@example.com`).
- [ ] La branche par défaut doit s'appeler `main` : le travail est aujourd'hui
      sur `fix/sdk-node-aligne-contrat`, et la CI ne se déclenche sur push que
      pour `main` (les autres branches sont couvertes par leur pull request).
- [ ] Décider si `PUBLICATION.md` (ce fichier) reste dans le dépôt public.

## 2. Création

- [ ] Organisation **itick-app**, nom **itick-integrations**.
- [ ] **Créer le dépôt en privé**, pousser, laisser tourner la CI une fois,
      puis basculer en public. Un dépôt public dont la première CI échoue
      donne une mauvaise première impression, et une erreur repérée en privé
      s'efface ; en public, elle reste dans l'historique.
- [ ] Ne pas laisser GitHub ajouter un README, un .gitignore ou une licence :
      ils sont déjà dans le dépôt.
- [ ] Description : « SDK Node et connecteurs de référence pour l'API
      partenaire ITICK. »
- [ ] Site web : `https://itick.fr/partenaires/documentation`.
- [ ] Topics : `itick`, `invoice`, `factur-x`, `nodejs`, `typescript`,
      `stripe`, `webhook`, `pos`.

## 3. Settings → General

- [ ] **Features** : Issues **activées** · Wiki **désactivé** ·
      Projects **désactivé** · Discussions **désactivées** ·
      Sponsorships **désactivé**.
- [ ] **Pull Requests** : n'autoriser que *Squash merging* ·
      *Automatically delete head branches* **activé**.
- [ ] **Private vulnerability reporting** : **activé** (complète SECURITY.md
      par un canal privé côté GitHub).

## 4. Settings → Branches (ou Rules → Rulesets) — protection de `main`

- [ ] *Require a pull request before merging* — 0 approbation obligatoire
      (équipe d'une personne), mais le passage par une PR force la CI.
- [ ] *Require status checks to pass before merging*, en cochant **`Node 20`**
      et **`Node 22`** (les deux jobs de la matrice CI).
      ⚠️ Ces checks n'apparaissent dans la liste **qu'après un premier run** :
      pousser une fois, puis revenir cocher.
- [ ] *Require branches to be up to date before merging*.
- [ ] *Require conversation resolution before merging*.
- [ ] **Block force pushes** (⚠️ *Allow force pushes* doit rester **décoché**).
- [ ] *Restrict deletions* : interdire la suppression de `main`.
- [ ] *Require linear history* (facultatif, cohérent avec le squash merge).
- [ ] Ne pas cocher *Do not allow bypassing the above settings* si tu veux
      garder la main en cas d'urgence — mais alors sache que l'admin (toi)
      peut tout contourner : la protection vaut pour les contributeurs.

## 5. Settings → Actions → General

- [ ] *Actions permissions* : « Allow `itick-app` actions » + « Allow actions
      created by GitHub » suffisent — la CI n'utilise que `actions/checkout` et
      `actions/setup-node`, épinglées par SHA.
- [ ] *Fork pull request workflows from outside collaborators* :
      **Require approval for all external contributors** — sinon n'importe qui
      exécute du code sur nos runners via une PR.
- [ ] *Workflow permissions* : **Read repository contents permission**
      (lecture seule). Décocher « Allow GitHub Actions to create and approve
      pull requests ».
- [ ] Aucun secret à créer : la CI n'en utilise aucun.

## 6. Settings → Code security

- [ ] *Dependency graph* : activé.
- [ ] *Dependabot alerts* : activé.
- [ ] *Dependabot security updates* : activé.
- [ ] *Secret scanning* + *Push protection* : activés (gratuits sur un dépôt
      public — bloque un `git push` qui contiendrait une clé).
- [ ] *Code scanning (CodeQL)* : « Default setup » pour JavaScript/TypeScript,
      facultatif mais gratuit ici.

## 7. Labels utilisés par les gabarits

- [ ] Créer les labels **`bogue`** et **`question`**. Les gabarits d'issue les
      appliquent ; un label inexistant est ignoré silencieusement.

## 8. Après le passage en public — à vérifier

- [ ] La page d'accueil affiche le README, et la barre latérale détecte bien
      **« MIT License »** et **« Security policy »**.
- [ ] *New issue* propose les deux gabarits (Bogue, Question d'intégration),
      **ne propose pas** d'issue vierge, et les quatre liens de la page
      (documentation, API, inscription sandbox, SECURITY.md) répondent.
- [ ] Une PR de test affiche bien le gabarit de PR, et la CI s'y déclenche.
- [ ] La CI est **verte sur Node 20 et 22** (séquence vérifiée en local le
      2026-08-29 : install → typecheck → build → test sur les deux paquets,
      15 tests SDK + 24 tests connecteur, `npm audit` sans vulnérabilité).
- [ ] *Insights → Dependency graph → Dependabot* liste les **trois**
      écosystèmes (`/sdk-node`, `/stripe-connector`, `github-actions`) sans
      erreur d'analyse du fichier.
- [ ] La protection de `main` est effective : tenter un `git push --force`
      dessus doit être **refusé** (test négatif — sans ce test, on ne sait pas
      si la règle est appliquée).
- [ ] Secret scanning n'a rien remonté.
- [ ] Quelqu'un relève réellement <support@itick.fr> et <partenaires@itick.fr> :
      SECURITY.md promet un accusé de réception sous 5 jours ouvrés.
- [ ] Relire la page d'accueil en se mettant à la place d'un éditeur de caisse
      qui ne connaît pas ITICK : rien n'y laisse croire qu'ITICK est une
      plateforme immatriculée (PDP), et la gratuité de l'intégration est dite.

## 9. Si un jour les paquets sont publiés sur npm

- [ ] `sdk-node/package.json` a `"files": ["dist", "README.md"]` : le
      LICENSE étant à la **racine du dépôt**, il ne serait **pas** inclus dans
      le paquet npm. Copier `LICENSE` dans chaque paquet (ou l'ajouter à
      `files`) avant toute publication — la licence MIT exige que la notice
      accompagne les redistributions.
- [ ] `publishConfig.access = public` est déjà positionné dans les deux
      `package.json` (les paquets sont sous le scope `@itick`, privé par
      défaut).
- [ ] Le connecteur dépend du SDK par `file:../sdk-node` : cette dépendance
      doit devenir une version npm avant publication du connecteur.

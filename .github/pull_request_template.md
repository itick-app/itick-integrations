> ⚠️ **Avant de publier cette PR : aucune clé API, aucun secret de webhook,
> aucune donnée personnelle réelle** (nom, e-mail, SIRET, facture d'un vrai
> client) dans le code, les tests, les captures ou ce message. Cette page est
> publique. Utilisez des valeurs factices (`itick_sandbox_xxx`, `whsec_xxx`,
> `client@example.com`).
>
> Une **faille de sécurité** ne se corrige pas par une PR publique : écrivez
> d'abord à support@itick.fr (voir [SECURITY.md](https://github.com/itick-app/itick-integrations/blob/HEAD/SECURITY.md)).

## Ce que ça corrige

<!-- Le problème, pas la liste des fichiers touchés. Lien vers l'issue si elle existe. -->

## Comment le vérifier

<!-- Les commandes lancées et leur résultat, ou le test qui échouait avant. -->

## Paquets touchés

- [ ] `sdk-node` (`@itick/ingest`)
- [ ] `stripe-connector` (`@itick/stripe-connector`)
- [ ] Dépôt (documentation, CI, gouvernance)

## Vérifications

- [ ] `npm run typecheck`, `npm run build` et `npm test` passent dans chaque paquet touché
      (le SDK se compile avant le connecteur, qui en dépend).
- [ ] Un test couvre le changement — ou j'explique ci-dessus pourquoi il n'y en a pas.
- [ ] Aucune clé, aucun secret, aucune donnée réelle dans le diff.
- [ ] Aucune nouvelle dépendance d'exécution (sinon, elle est justifiée ci-dessus).
- [ ] Ni `version` ni publication npm modifiées : ces décisions appartiennent à ITICK.
- [ ] Changement de comportement visible → `CHANGELOG.md` mis à jour.
- [ ] J'accepte que cette contribution soit distribuée sous licence MIT (voir
      [CONTRIBUTING.md](https://github.com/itick-app/itick-integrations/blob/HEAD/CONTRIBUTING.md)).

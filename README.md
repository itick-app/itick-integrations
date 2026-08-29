# ITICK — intégrations

Code d'intégration d'[ITICK](https://itick.fr) publié sous licence MIT : un SDK
Node et un connecteur de référence, pour envoyer des tickets et des factures à
l'API partenaire d'ITICK.

Public visé : éditeurs de logiciels de caisse (POS), de facturation ou
d'e-commerce qui veulent transmettre les documents qu'ils émettent à ITICK, qui
les certifie (Factur-X, horodatage RFC 3161, piste d'audit fiable) et les route
vers le client final.

**L'intégration est gratuite pour les éditeurs** : transmettre des tickets ou
des factures à ITICK depuis votre logiciel ne coûte rien, ni à la mise en
service, ni à l'usage.

## Contenu du dépôt

| Paquet | Rôle |
|---|---|
| [`sdk-node/`](sdk-node) — `@itick/ingest` | SDK TypeScript/Node, zéro dépendance, pour pousser un reçu (unitaire ou par lot) vers l'API partenaire. |
| [`stripe-connector/`](stripe-connector) — `@itick/stripe-connector` | Connecteur de référence : reçoit les webhooks Stripe `invoice.paid`, mappe la facture et la pousse vers ITICK via le SDK. Sert aussi d'exemple complet d'intégration. |

Chaque paquet a son propre README avec l'installation, les champs requis et les
pièges connus.

## Ce que ce dépôt n'est pas

- **Ce n'est pas le produit ITICK.** L'application et l'API d'ITICK ne sont pas
  ici : ce dépôt ne contient que du code client destiné à s'y connecter.
- **Ce n'est pas un client officiellement supporté avec engagement de niveau de
  service.** Ces paquets sont fournis « en l'état », sans garantie ni
  engagement de délai de correction ou de disponibilité. Les questions sont les
  bienvenues (voir plus bas), mais aucun SLA n'y est attaché.
- **Aucun paquet n'est publié sur npm** à ce jour : l'installation se fait
  depuis ce dépôt (`npm install file:…`), voir le README de chaque paquet.
- **ITICK n'est pas une plateforme de dématérialisation partenaire (PDP)
  immatriculée** par l'administration fiscale. Rien dans ce dépôt ne doit être
  lu comme une immatriculation ou un agrément.

## Obtenir une clé sandbox

1. Remplissez le formulaire d'inscription partenaire :
   <https://itick.fr/partenaires/inscription>.
2. Vous recevez une clé `itick_sandbox_…`. La sandbox n'a **aucun effet
   comptable** : rien de ce que vous y envoyez n'est facturé ni transmis à un
   client final.
3. Poussez votre premier reçu en suivant le
   [quickstart du SDK](sdk-node/README.md#quickstart).

Sans nouvelle de votre clé, écrivez à <partenaires@itick.fr>.

## Travailler sur ce dépôt

Node ≥ 18 (la CI vérifie sur Node 20 et 22). Le connecteur dépend du SDK par
chemin local : **le SDK doit être compilé avant** que le connecteur ne
type-vérifie.

```bash
cd sdk-node          && npm ci && npm run build && npm test
cd ../stripe-connector && npm ci && npm run build && npm test
```

## Documentation

- Guide d'intégration : <https://itick.fr/partenaires/documentation>
- Documentation interactive de l'API : <https://api.itick.fr/itick/partner/docs>
- Contrat OpenAPI : <https://api.itick.fr/itick/partner/docs/spec.yml>

## Contact

- Question d'intégration : ouvrez une
  [issue](https://github.com/itick-app/itick-integrations/issues) ou écrivez à
  <support@itick.fr>.
- Partenariats et accès sandbox : <partenaires@itick.fr>.
- **Faille de sécurité : ne l'ouvrez pas en issue publique.** La procédure est
  décrite dans [SECURITY.md](SECURITY.md).

## Contribuer

Les contributions sont acceptées sous licence MIT — voir
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, © 2026 ITICK SAS. Voir [LICENSE](LICENSE).

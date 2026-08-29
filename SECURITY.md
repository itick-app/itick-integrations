# Politique de sécurité

Merci de nous aider à garder ce code sûr. Cette page décrit **où signaler**,
**ce qui est couvert** et **ce que nous nous engageons à faire**.

## Signaler une faille

Écrivez à **<support@itick.fr>** avec `[SÉCURITÉ]` en début d'objet.

**N'ouvrez pas d'issue publique** pour une faille : une issue est visible de
tous dès la première seconde.

Un bon signalement contient :

- le paquet et la version ou le commit concerné (`sdk-node` / `stripe-connector`) ;
- ce qu'un attaquant obtient concrètement (lecture de données, contournement de
  la vérification de signature, exécution de code…) ;
- les étapes de reproduction, si possible sur un dépôt ou un extrait minimal ;
- votre évaluation de la gravité, si vous en avez une.

> ⚠️ **Ne joignez jamais de clé API réelle, de secret de webhook, ni de données
> personnelles** (clients, salariés, factures réelles) à un signalement.
> Anonymisez vos exemples et utilisez des valeurs factices (`itick_sandbox_xxx`,
> `whsec_xxx`). Si une clé réelle a fuité — dans un message, une capture, un
> dépôt public — dites-le nous tout de suite : nous la révoquons.

## Ce que nous nous engageons à faire

ITICK est une petite équipe : les délais ci-dessous sont ceux que nous pouvons
réellement tenir, pas des objectifs contractuels.

| Étape | Délai visé |
|---|---|
| Accusé de réception de votre message | 5 jours ouvrés |
| Première analyse : faille confirmée ou écartée, gravité estimée | 15 jours ouvrés |
| Correctif pour une faille critique ou élevée | dès que possible, et nous vous tenons informé de l'avancement |
| Correctif pour une faille modérée ou faible | intégré à un prochain lot de travaux, sans date garantie |

Nous vous disons ce que nous décidons, y compris quand nous décidons de ne pas
corriger — avec la raison.

Nous vous demandons de **ne pas divulguer publiquement** la faille avant qu'un
correctif soit disponible, ou 90 jours après votre signalement si nous n'avons
rien livré d'ici là. Si vous le souhaitez, nous vous créditons dans le
CHANGELOG.

**Il n'y a pas de programme de prime (bug bounty)** : nous ne rémunérons pas
les signalements.

## Périmètre

**Couvert** : le code de ce dépôt — `sdk-node/` (`@itick/ingest`) et
`stripe-connector/` (`@itick/stripe-connector`), y compris la CI de ce dépôt.
Seul l'état courant de la branche par défaut est maintenu : il n'y a pas de
rétroportage sur d'anciennes versions.

**Hors périmètre de ce dépôt** :

- l'infrastructure et les services d'ITICK (`itick.fr`, `api.itick.fr`, les
  applications mobiles et web). Ils ne sont pas hébergés ici. Un problème de ce
  côté se signale à la même adresse, <support@itick.fr>, mais il est traité
  séparément et il ne faut **pas** ouvrir d'issue publique dessus ;
- les dépendances tierces et les services tiers (Stripe, npm, GitHub) : signalez
  la faille à l'éditeur concerné ; écrivez-nous si notre code en aggrave l'effet.

**À ne pas faire** : tester une faille sur l'API de production, sur des données
qui ne sont pas les vôtres, ou exécuter des scans automatisés contre les
services d'ITICK. Une clé sandbox est fournie sur demande pour vos essais
(<partenaires@itick.fr>).

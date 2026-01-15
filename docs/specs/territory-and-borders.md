# Spécification : Territoire et bordures

## Objectif
Cette page décrit comment le moteur calcule l'appartenance territoriale à partir des systèmes stellaires et en quoi elle se distingue des mécaniques de gameplay qui s'appuient directement sur les champs `ownerFactionId` des systèmes et des planètes.

## Paramètres clefs
- **Rayon d'influence** : `TERRITORY_RADIUS = 28` (dans `data/static.ts`). Ce rayon fixe la portée maximale d'un système pour revendiquer de l'espace autour de lui.

## Calcul du territoire (moteur)
La fonction `src/engine/territory.ts#getTerritoryOwner` détermine l'ID de faction qui contrôle un point 3D (`Vec3`), ou `null` si l'espace est neutre.

Étapes :
1. **Filtrer** les systèmes sans propriétaire (`ownerFactionId === null`). Seuls les systèmes contrôlés projettent une influence.
2. **Trier** les systèmes restants par `id` pour garder un comportement déterministe en cas d'égalité de distance.
3. **Identifier le système le plus proche** du point cible en comparant les distances au carré (`distSq`).
4. **Détecter les égalités** : si deux systèmes de factions différentes sont exactement à la même distance minimale, l'espace est contesté et donc **neutre** (`null`).
5. **Vérifier la portée** : si la distance minimale dépasse `TERRITORY_RADIUS`, le point est trop éloigné et reste neutre.
6. **Retourner la faction** du système le plus proche si aucune condition de neutralité n'a été rencontrée.

Conséquences :
- Un rayon fixe tronque les cellules de Voronoï ; au-delà, l'espace reste libre.
- Les égalités de distance entre factions différentes rendent la zone neutre (aucun vainqueur implicite).
- La logique moteur ne tient pas compte de la présence de planètes ou d'autres entités : seule la position des systèmes et leur propriétaire importe.

## Distinction avec le gameplay
- Les systèmes et planètes possèdent leur propre `ownerFactionId` (`src/shared/types.ts`), utilisé par les mécaniques de capture, d'économie ou d'invasion. Le territoire calculé par `getTerritoryOwner` ne remplace pas ces valeurs.
- Une planète peut appartenir à une faction différente de la zone de territoire où elle se trouve si la logique de gameplay l'autorise.
- Les zones neutres (au-delà du rayon ou en cas d'égalité parfaite) n'accordent aucun droit particulier en gameplay.

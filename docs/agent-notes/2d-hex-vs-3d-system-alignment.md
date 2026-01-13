# 2D hex map vs 3D system realism

Contexte
- La vue 2D de surface est forcement schematique (grille hex), tandis que la vue systeme 3D exige une forte vraisemblance.
- Objectif: maintenir une coherence semantique (ce que represente un biome/relief/feature) tout en acceptant que les rendus n'aient pas la meme nature visuelle.

Reflexion
- La 2D doit rester une carte tactique lisible: couleurs franches, symboles clairs, pas de sur-detail.
- La 3D doit etre credible: micro-variation, ombrage, details de relief, atmospheres et emission nocturne.
- Le lien entre les deux doit etre donnees-first: la meme source (tiles + features) produit les deux rendus, mais avec des filtres esthetiques differents.
- Sans projection 2D "realiste", la coherence depend surtout de: palette partagee, conventions d'orientation, et effets derives des memes champs (elevation, humidite, temperature, settlements).

Plan d'action
1) Fixer une convention canonique d'orientation et d'UV (north, meridien 0, sens de v) et la documenter.
2) Definir une palette biome canonique unique et deriver des variantes:
   - 2D: teinte directe, contraste eleve pour lecture.
   - 3D: base identique + variations de relief/climat.
3) Securiser le pipeline 3D:
   - Couleur de base issue des tiles (biome) pour alignement global.
   - Details (noise, relief, cloud shadow) en couches secondaires et optionnelles.
4) Lier les features visibles aux memes donnees:
   - Emissive (villes) et cues de relief/altitude issus des tiles.
5) Ajouter un outil de verification rapide:
   - Debug overlay (ex: survol tile -> highlight sur sphere).
   - Check visuel de points d'ancrage (capitale, zones d'eau, chaines de relief).
6) Valider sur 2-3 profils planetes (terre-like, glace, volcanique) pour garantir la coherence per-biome.

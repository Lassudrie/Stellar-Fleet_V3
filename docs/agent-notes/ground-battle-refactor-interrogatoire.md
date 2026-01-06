# Interrogatoire detaille - refonte combat terrestre

Objectif: recueillir les decisions de design necessaires avant d'ecrire la spec v2 et de lancer la refonte.

## 1) Portee et objectifs
1) Quelles fonctionnalites du modele actuel doivent etre conservees (ex: supply, fatigue, ZOC) et lesquelles doivent etre supprimees?
2) La refonte couvre-t-elle uniquement les batailles terrestres ou aussi les regles d'invasion orbitales (bombardement, blocus)?
3) Souhaitez-vous un MVP jouable d'abord, puis des iters (artillerie, fortifications, etc.)?

## 2) Unite terrestre - capacites et stats
1) Quelles stats sont obligatoires pour chaque unite (ex: members, attack, defense, condition, morale, range, move)?
2) Faut-il ajouter des tags systeme (ex: artillery, airborne, engineer, armored, hardened)?
3) Chaque unite a-t-elle une "projection de force" distincte de l'attaque directe (ex: tir a distance, ZOC)?
4) Certaines unites peuvent-elles contourner certains terrains (ex: amphibie, montagne)?
5) Existe-t-il un plafond dur sur le nombre d'unites par bataille ou par hex?

## 3) Stacking (plusieurs unites par hex)
1) Penalite de stacking au-dela de 2: formule exacte? (ex: -X% attaque/defense par unite excedentaire, ou pertes accrues)
2) La penalite s'applique-t-elle a toutes les unites dans l'hex ou seulement aux excedentaires?
3) La penalite depend-elle du type d'unite ou du terrain?
4) Existe-t-il un plafond maximum d'unites par hex (hard cap)?
5) Le stacking influe-t-il sur le cout de mouvement ou seulement sur le combat?

## 4) Mouvement et pathfinding
1) Le modele actuel (MP, cout terrain, ZOC) est-il conserve?
2) Les unites peuvent-elles traverser un hex occupe par une autre faction (sans s'arreter)?
3) Les unites peuvent-elles se deplacer et attaquer le meme tour? Y a-t-il un malus?
4) Y a-t-il une vitesse min (ex: 1 hex minimum si ordre donne)?
5) Le cout de mouvement doit-il tenir compte du stacking (terrain encombre)?

## 5) Attaque et projection de force
1) L'attaque se fait-elle uniquement en adjacent (hex voisins), ou y a-t-il des portees?
2) Si portee, comment est gere le tir indirect (ligne de vue, malus, cover)?
3) La projection de force sert-elle a interdire des mouvements (ZOC) ou a infliger des pertes passives?
4) Les attaques de plusieurs unites sur une meme cible sont-elles autorisees le meme tour?
5) Existe-t-il un ordre "support" (ex: tir d'appui) distinct de l'attaque?

## 6) Resolution de combat
1) Formule de base souhaitee (ratio A/D, RNG faible, attrition, break)?
2) Souhaitez-vous un modele "multi-attaquants vs defenseur" ou du 1v1 serie?
3) Les engagements sont-ils limites en nombre par tour (pour des raisons perf)?
4) Comment se gere la retraite / la deroute (recul sur hex libre, destruction si bloque)?
5) Quel seuil exact definit une unite "detruite" (members=0, condition < X, morale < X)?

## 7) Terrain, biomes, infrastructures
1) Les terrains existants (Urban, Hills, etc.) suffisent-ils, ou faut-il en ajouter?
2) Les infrastructures (settlements, ground buildings) donnent-elles des bonus defensifs?
3) Les routes/rivieres influencent-elles les mouvements ou la defense?
4) Les biomes impassables (ocean) restent-ils strictement interdits?
5) Les fortifications ou bunkers sont-ils prevus a court terme?

## 8) Supply, moral, fatigue
1) Le systeme de supply doit-il rester (distance BFS)? Le rayon ou sources changent-ils?
2) Quels effets du manque de supply (mouvement, attaque, condition, pertes)?
3) La condition/morale se regenere-t-elle? A quel rythme et sous quelles conditions?
4) Unites "fraiches" vs "epuisees": quelles regles precises?
5) Souhaitez-vous un modele de reinforcement (ex: reconstitution progressive)?

## 9) Settlements - capture et controle
1) Capture immediate: quelle definition exacte du controle? (presence d'au moins 1 unite)
2) Si plusieurs factions sur l'hex settlement, est-ce "contested" (pas de controle)?
3) Le controle persiste-t-il si l'hex est vide (memoire de controle)?
4) Quelle relation entre controle settlement et supply?
5) Faut-il distinguer types de settlements (outpost vs city) pour le controle?

## 10) Condition de victoire au sol
1) Victoire attaquant: controle de tous les settlements du body. Confirme pour planetes sans settlement?
2) Victoire defenseur: destruction ou deroute de toutes les unites ennemies. Quid des unites en orbite?
3) Que se passe-t-il si un attaquant controle tous les settlements mais des defenders restent ailleurs?
4) Victoire multi-factions: comment determine-t-on un gagnant unique?
5) Quand la victoire est atteinte, que devient le reste des unites (cleanup immediat, retrait)?

## 11) Debarquement (phase dediee)
1) Ordonnancement exact: phase choix -> phase resolution pertes -> assignation surfacePos -> phase mouvement?
2) La selection se fait-elle par unite et par hex (oui) ou par groupe?
3) La resolution de pertes depend-elle des defenses presentes (units, buildings, settlements)?
4) Formule de pertes: pourcentage fixe, RNG, ou calcul base sur puissance defense/projection?
5) Debarquement force: une unite peut etre totalement detruite avant de poser pied?
6) Unites qui ne debarkent pas: restent embarquees sans effet?
7) Les hex de debarquement peuvent-ils etre occupes (stacking) ou seulement libres?
8) Peut-on debarquer sur un hex non passable (coast/ocean)? Regles amphibies?
9) L'assaut aerien ou orbital different-t-il de l'assaut au sol?

## 12) Interaction orbite / sol
1) Le bombardement orbital intervient avant ou apres le debarquement?
2) Peut-il cibler des zones de debarquement pour augmenter les pertes?
3) L'orbite contestee modifie-t-elle les pertes de debarquement?
4) Les defenses anti-orbitales terrestres doivent-elles etre modelisees?
5) Faut-il bloquer le debarquement si pas de controle orbital?

## 13) Commandes et flux joueur
1) Souhaitez-vous une nouvelle commande (ex: ORDER_GROUND_LAND) ou extension de UNLOAD_ARMY?
2) Les ordres de movement/attaque restent-ils persistants par unite?
3) Faut-il un ordre de "hold" ou "capture" specifique?
4) L'UI doit-elle permettre un mode multi-selection et planification?
5) Les actions doivent-elles etre confirmables/annulables avant fin de tour?

## 14) Synchro multi-vues (galaxie, systeme, surface)
1) Quels indicateurs minimums doivent apparaitre dans chaque vue (ex: controle settlements, forces au sol)?
2) A quelle frequence l'etat de surface est-il rafraichi dans la vue systeme?
3) Faut-il des logs specifiques liant un choix sur surface a un resultat dans la vue galaxie?
4) L'UI doit-elle montrer les zones de debarquement planifiees avant resolution?
5) Quels elements doivent etre deterministes dans le rendu (positions, logs)?

## 15) IA
1) Strategie d'IA pour choix de zone de debarquement (proximite settlements, defense, terrain)?
2) IA doit-elle eviter le stacking penalise?
3) Priorites d'attaque: settlements, unites, supply?
4) IA doit-elle reconnaitre quand se retirer/annuler le debarquement?
5) Parametres d'agressivite par profil?

## 16) Logs, messages et feedback
1) Niveau de detail des logs (par engagement, par settlement, par phase)?
2) Faut-il des messages specifiques pour pertes de debarquement?
3) Les logs doivent-ils etre agreges par body ou par engagement?
4) Quelles infos afficher en UI (pertes, stack penalty, supply)?
5) Format et localisation i18n des nouveaux messages?

## 17) Save format et migrations
1) Quels nouveaux champs sont a serialiser (controle settlements, ordres de debarquement)?
2) Migration des saves existantes: comportement par defaut?
3) Version de save (bump obligatoire)?
4) Les nouveaux champs doivent-ils etre retro-compatibles?
5) Comment backfiller l'etat si une save n'a pas de donnees de controle?

## 18) Determinisme et performance
1) Quelle granularite de RNG (par engagement, par hex, par phase)?
2) Quelles boucles doivent etre triees explicitement (ordre stable)?
3) Limites de perf acceptable (taille de map, nombre d'unites)?
4) Faut-il des caches deterministes (pathfinding, terrain)?
5) Quelles operations doivent rester strictement pure?

## 19) Tests et validation
1) Quels tests sont prioritaires (debarquement, capture, stacking)?
2) Souhaitez-vous des tests de reproduction seed/turn?
3) Des tests de perf (nombre d'unites/hex) sont-ils necessaires?
4) Quels cas limites doivent etre couverts (pas de settlement, planetes multiples, multi-factions)?
5) Souhaitez-vous une smoke sim specifique?

## 20) Equilibrage et parametres
1) Quels parametres doivent etre exposes dans `GROUND_UNIT_STATS`?
2) Souhaitez-vous des constantes config pour le stacking penalty?
3) Valeurs cibles de pertes au debarquement?
4) Valeurs cibles de duree moyenne d'une bataille?
5) Priorite: realisme tactique ou lisibilite/simplicite?

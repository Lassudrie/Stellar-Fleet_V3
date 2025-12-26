# Opérations de transport d'armées

Cette spécification décrit les règles de chargement, de débarquement et de transfert d'armées, ainsi que les contraintes associées aux transports.

## Conditions de chargement
- Une flotte doit être en orbite d'un système solide : `FleetState.ORBIT` et distance orbitale valide (`ORBIT_PROXIMITY_RANGE_SQ`).
- Les armées éligibles sont déployées sur une planète solide du système, appartiennent à la même faction et sont en état `DEPLOYED`.
- Seuls les `TRANSPORTER` vides peuvent charger. Le calcul limite le nombre d'armées à la capacité de transports disponibles.
- Les armées passent à l'état `EMBARKED` et sont référencées par l'identifiant du fleet transporteur. Un journal de mouvement est émis à chaque lot chargé.

## Conditions de débarquement
- La flotte doit être en orbite valide du système cible (mêmes contrôles que pour le chargement).
- Seules les armées `EMBARKED` dans la flotte et appartenant à la même faction peuvent être débarquées.
- La planète cible doit être solide. À défaut, le jeu choisit la planète solide par défaut du système.
- Les transports concernés sont vidés (`carriedArmyId` remis à `null`) et les armées passent à l'état `DEPLOYED` sur la planète cible, avec journal associé.

## Sélection des transports et `transferBusyUntilDay`
- Les transports candidats sont filtrés en orbite autour du système, sans armée embarquée et non occupés (`transferBusyUntilDay` < jour courant).
- Les candidats sont triés par identifiant de flotte puis de vaisseau pour garantir une sélection stable.
- Lors d'un transfert planète→planète, le transport utilisé est marqué occupé pour le jour courant (`transferBusyUntilDay = day`) afin d'empêcher tout second transfert ce tour-là.

## Risque de débarquement en orbite contestée
- Le débarquement reste autorisé en orbite contestée (`isOrbitContested`).
- Chaque armée débarquée subit un jet : échec si `rng < 0.35` (`CONTESTED_UNLOAD_FAILURE_THRESHOLD`).
- En cas d'échec, la force perd 35 % (`CONTESTED_UNLOAD_LOSS_FRACTION`) avec un minimum de 1 point, et un journal de combat indique les pertes.
- En cas de succès, un journal note l'esquive des tirs. Le débarquement effectif n'est jamais annulé : seul l'attrition change.

## Transfert planète→planète
- L'ordre `TRANSFER_ARMY_PLANET` ne s'applique qu'à une armée `DEPLOYED` située sur la planète source dans le système visé.
- La planète source et la planète cible doivent être solides et appartenir au même système que l'ordre.
- Le système recherche un transport disponible en orbite (voir sélection ci-dessus) ; si aucun n'est disponible, l'ordre échoue silencieusement.
- L'armée conserve l'état `DEPLOYED` mais son `containerId` devient l'identifiant de la planète cible. Un journal de mouvement décrit le transfert et le transporteur utilisé.

## Références aux constantes clés
- Portée orbitale : `ORBIT_PROXIMITY_RANGE_SQ` (contrôles de chargement/débarquement et disponibilité des transports).
- Types éligibles : `ShipType.TRANSPORTER`.
- Risque d'orbite contestée : `CONTESTED_UNLOAD_FAILURE_THRESHOLD = 0.35`, `CONTESTED_UNLOAD_LOSS_FRACTION = 0.35`.
- Gel d'utilisation des transports : `transferBusyUntilDay` fixé au jour courant après un transfert planétaire.

import { ShipType } from '../../../shared/types';

import carrier from './carrier.png';
import cruiser from './cruiser.png';
import destroyer from './destroyer.png';
import frigate from './frigate.png';
import fighter from './fighter.png';
import bomber from './bomber.png';
import transporter from './transporter.png';
import builder from './builder.png';
import support from './support.png';
import tanker from './tanker.png';
import extractor from './extractor.png';

export const SHIP_ICONS: Record<ShipType, string> = {
  [ShipType.CARRIER]: carrier,
  [ShipType.CRUISER]: cruiser,
  [ShipType.DESTROYER]: destroyer,
  [ShipType.FRIGATE]: frigate,
  [ShipType.FIGHTER]: fighter,
  [ShipType.BOMBER]: bomber,
  [ShipType.TRANSPORTER]: transporter,
  [ShipType.BUILDER]: builder,
  [ShipType.SUPPORT]: support,
  [ShipType.TANKER]: tanker,
  [ShipType.EXTRACTOR]: extractor
};

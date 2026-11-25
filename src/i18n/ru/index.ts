// Russian dictionary: one file per area (merged here). Keys are flat «area.name»; the English side must have the same.
import { common } from './common';
import { bg } from './bg';
import { sign } from './sign';
import { screens } from './screens';
import { agents } from './agents';

export const ru = { ...common, ...bg, ...sign, ...screens, ...agents };

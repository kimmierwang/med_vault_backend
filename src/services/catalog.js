import { DrugCatalog } from '../models/index.js';

// Drugs whose barcode the app can recognise. To add more, add an entry here and restart the server
// (existing entries are updated in place, nothing is duplicated).
export const CATALOG_DRUGS = [
  {
    barcode: '8904030852306',
    name: 'Ceproza 500mg',
    category: 'Antibiotic',
    composition: 'Ciprofloxacin caplets U.S.P. 500mg',
    description: 'Broad spectrum antibiotic',
    packSize: '1x10 caplets',
    nafdacRegNo: 'A4-1838',
    mfgLicenseNo: '',
    batchNumber: '',
    mfgDate: '05/2025',
    expDate: '05/2028',
  },
  {
    barcode: '8902440113260',
    name: 'Acethic tablets',
    category: 'Analgesic',
    composition: 'Aceclofenac & Paracetamol',
    description: '',
    packSize: '1x10 tablets',
    nafdacRegNo: 'B4-9501',
    mfgLicenseNo: 'KD-135',
    batchNumber: 'DG0135',
    mfgDate: '07/2024',
    expDate: '06/2027',
  },
];

export async function seedCatalog() {
  await DrugCatalog.bulkWrite(
    CATALOG_DRUGS.map((d) => ({ updateOne: { filter: { barcode: d.barcode }, update: { $set: d }, upsert: true } }))
  );
  console.log(`Drug catalog ready (${CATALOG_DRUGS.length} drugs)`);
}

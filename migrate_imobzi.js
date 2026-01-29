const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');

const IMOBZI_API_SECRET = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aGlyZF9wYXJ0eV9hcHBfaWQiOjk4MDI0MzIzNSwiY3JlYXRlZF9hdCI6IjIwMjMtMDQtMDVUMTQ6NTQ6MDkuMzE3MTMxWiIsImlzX3RoaXJkX3BhcnR5X2FjY2VzcyI6dHJ1ZX0.d4_rVD2aR7LFpDrkvylmzR1M_MeVlg48hIbtYZtGBGE';
const IMOBZI_BASE_URL = 'https://api.imobzi.app/v1';

const pool = new Pool({
    host: 'aws-1-us-east-1.pooler.supabase.com',
    port: 6543,
    user: 'postgres.tkuhoyzktoogbybgomfy',
    password: 'imobx110398',
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 10, 
});

const COMPANY_ID = '13b0ff9c-10e4-4abc-9fd8-313ecc1d132c';
const RESPONSIBLE_USER_ID = '629e6552-86a7-4234-bfc0-ad2bd02bad9d';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const cleanHtml = (rawHtml) => (rawHtml || "").replace(/<br\s*\/?>/gi, '\n').replace(/<.*?>/g, '').replace(/&nbsp;/g, ' ').trim();

const mapPropertyType = (imobziType) => {
    const mapping = { 'Casa': 'house', 'Casa em Condomínio': 'house', 'Apartamento': 'apartment', 'Terreno': 'land', 'Comercial': 'commercial', 'Chácara': 'rural', 'Sítio': 'rural', 'Fazenda': 'rural' };
    return mapping[imobziType] || 'house';
};

const mapPropertyStatus = (imobziStatus) => {
    const mapping = { 'available': 'available', 'rented': 'rented', 'solded': 'sold', 'pending': 'maintenance' };
    return mapping[imobziStatus] || 'available';
};

const extractCondoFee = (details) => {
    if (!details.fields) return 0;
    const allFields = Object.values(details.fields).flat(2);
    const condoField = allFields.find(f => f.field_id === 'condominium');
    return condoField && condoField.value ? parseFloat(condoField.value) : 0;
};

async function apiRequest(url, method = 'get', data = null) {
    let retries = 0;
    const maxRetries = 10;
    const headers = { 'X-Imobzi-Secret': IMOBZI_API_SECRET };
    while (retries < maxRetries) {
        try {
            const response = await axios({ url, method, data, headers, timeout: 20000 });
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const message = error.response?.data?.message || "";
            if (status === 429 || (status === 401 && message.includes("Rate limit"))) {
                retries++;
                const waitTime = Math.pow(2, retries) * 1000 + Math.random() * 1000;
                log(`⚠ Rate limit. Aguardando ${Math.round(waitTime/1000)}s...`);
                await sleep(waitTime);
            } else { throw error; }
        }
    }
    throw new Error("Rate limit persistente.");
}

async function getOrCreateCondominium(client, details) {
    if (!details.building_name || details.building_name.trim() === "") return null;
    const condoName = details.building_name.trim();
    try {
        const existing = await client.query('SELECT id FROM condominiums WHERE name = $1 AND company_id = $2', [condoName, COMPANY_ID]);
        if (existing.rows.length > 0) return existing.rows[0].id;
        const condoData = {
            name: condoName,
            address: details.address || 'Endereço não informado',
            street: details.address ? details.address.split(',')[0] : 'Rua não informada',
            neighborhood: details.neighborhood || 'Bairro não informado',
            city: details.city || 'Marília',
            state: details.state || 'SP',
            "zipCode": details.zipcode || '00000-000',
            "isActive": true,
            company_id: COMPANY_ID,
            created_by_id: RESPONSIBLE_USER_ID,
            created_at: new Date(),
            updated_at: new Date()
        };
        const cols = Object.keys(condoData).map(c => `"${c}"`);
        const vals = Object.values(condoData);
        const query = `INSERT INTO condominiums (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
        const res = await client.query(query, vals);
        const condoId = res.rows[0].id;
        log(`✓ Condomínio criado: ${condoName}`);
        if (details.cover_photo && details.cover_photo.url) {
            await client.query(`INSERT INTO condominium_images (original_name, file_name, file_path, file_url, file_size, mime_type, file_extension, status, category, company_id, condominium_id, display_order, is_main, aws_bucket, aws_key, aws_region) VALUES ($1, $2, $3, $4, 0, 'image/jpeg', 'jpg', 'active', 'general', $5, $6, $7, $8, 'migrated', 'migrated', 'us-east-1')`, [details.cover_photo.url.split('/').pop().substring(0, 255), `condo_${condoId}_main`, details.cover_photo.url, details.cover_photo.url, COMPANY_ID, condoId, 0, true]);
        }
        return condoId;
    } catch (e) { log(`✗ Erro condomínio ${condoName}: ${e.message}`); return null; }
}

async function setupDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const columns = [{ name: 'imobzi_id', type: 'VARCHAR' }, { name: 'imobzi_code', type: 'VARCHAR' }, { name: 'imobzi_url', type: 'TEXT' }];
        for (const col of columns) {
            await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='${col.name}') THEN ALTER TABLE properties ADD COLUMN ${col.name} ${col.type}; END IF; END $$;`);
        }
        await client.query(`DROP INDEX IF EXISTS idx_properties_company_imobzi_id`);
        await client.query(`CREATE UNIQUE INDEX idx_properties_company_imobzi_id ON properties("companyId", imobzi_id)`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_condominiums_company_name ON condominiums(company_id, name);`);
        await client.query('COMMIT');
        log("Setup DB OK.");
    } catch (e) { await client.query('ROLLBACK'); log("Erro setup DB: " + e.message); } finally { client.release(); }
}

async function processProperty(details, stats) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const condominiumId = await getOrCreateCondominium(client, details);
        const isAvailable = details.status === 'available';
        const condoFee = extractCondoFee(details);
        
        const propData = {
            title: details.site_title || `${details.property_type} em ${details.neighborhood}`,
            description: cleanHtml(details.site_description || details.description || "Sem descrição"),
            type: mapPropertyType(details.property_type),
            status: mapPropertyStatus(details.status),
            address: details.address || 'Não informado',
            city: details.city || 'Marília',
            state: details.state || 'SP',
            zipCode: details.zipcode || '00000-000',
            neighborhood: details.neighborhood || 'Bairro não informado',
            totalArea: parseFloat(details.area || 0),
            builtArea: parseFloat(details.useful_area || 0),
            bedrooms: parseInt(details.bedroom || 0),
            bathrooms: parseInt(details.bathroom || 0),
            parkingSpaces: parseInt(details.garage || 0),
            salePrice: parseFloat(details.sale_value || 0),
            rentPrice: parseFloat(details.rental_value || 0),
            condominiumFee: condoFee,
            condominium_id: condominiumId,
            features: JSON.stringify(details.nearby || []),
            isActive: isAvailable && (details.active !== false),
            companyId: COMPANY_ID,
            responsibleUserId: RESPONSIBLE_USER_ID,
            owner_name: 'Proprietário não informado',
            owner_email: 'contato@imobx.com.br',
            owner_phone: '(00) 0000-0000',
            owner_document: '000.000.000-00',
            owner_address: details.address || 'Endereço não informado', // CAMPO OBRIGATÓRIO
            code: details.code,
            imobzi_id: String(details.db_id),
            imobzi_code: details.code,
            imobzi_url: details.site_url,
            updated_at: new Date()
        };

        const cols = Object.keys(propData);
        const vals = Object.values(propData);
        const query = `INSERT INTO properties (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT ("companyId", imobzi_id) DO UPDATE SET ${cols.filter(c => c !== 'companyId' && c !== 'imobzi_id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')} RETURNING id, (xmax = 0) AS is_insert;`;
        const res = await client.query(query, vals);
        const propertyUuid = res.rows[0].id;
        res.rows[0].is_insert ? stats.inserted++ : stats.updated++;

        const photos = (details.photos && details.photos.photos) || [];
        for (const photo of photos) {
            const imgCheck = await client.query('SELECT id FROM gallery_images WHERE file_url = $1 AND property_id = $2', [photo.url, propertyUuid]);
            if (imgCheck.rows.length === 0) {
                await client.query(`INSERT INTO gallery_images (original_name, file_name, file_path, file_url, file_size, mime_type, file_extension, status, category, company_id, property_id, display_order, is_main, aws_bucket, aws_key, aws_region) VALUES ($1, $2, $3, $4, 0, 'image/jpeg', 'jpg', 'active', 'general', $5, $6, $7, $8, 'migrated', 'migrated', 'us-east-1')`, [photo.url.split('/').pop().substring(0, 255), photo.db_id.toString(), photo.url, photo.url, COMPANY_ID, propertyUuid, photo.position || 0, photo.position === 1]);
            }
        }
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); log(`Erro ${details.db_id}: ${error.message}`); stats.errors++; } finally { client.release(); }
}

async function migrate() {
    log("Iniciando Migração V21...");
    await setupDatabase();
    const smartLists = ['all', 'inactives', 'pending'];
    let stats = { inserted: 0, updated: 0, errors: 0, totalProcessed: 0 };
    for (const slist of smartLists) {
        let cursor = null;
        log(`Processando lista: ${slist}`);
        while (true) {
            let url = `${IMOBZI_BASE_URL}/properties?smart_list=${slist}&limit=50`;
            if (cursor) url += `&cursor=${cursor}`;
            try {
                const data = await apiRequest(url);
                const props = data.properties || [];
                for (const p of props) {
                    try {
                        const details = await apiRequest(`${IMOBZI_BASE_URL}/property/${p.db_id}`);
                        await processProperty(details, stats);
                        stats.totalProcessed++;
                        if (stats.totalProcessed % 10 === 0) log(`Progresso (${slist}): ${stats.totalProcessed} processados | I:${stats.inserted} U:${stats.updated} E:${stats.errors}`);
                    } catch (e) { log(`Erro fetch ${p.db_id}: ${e.message}`); stats.errors++; }
                    await sleep(200);
                }
                cursor = data.cursor;
                if (!cursor) break;
            } catch (error) { log(`Erro lista ${slist}: ${error.message}`); break; }
        }
    }
    log("Migração V21 Concluída.");
    await pool.end();
}

migrate().catch(err => { log("Erro fatal: " + err.message); pool.end(); });

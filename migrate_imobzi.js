const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');

// Configurações Imobzi
const IMOBZI_API_SECRET = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aGlyZF9wYXJ0eV9hcHBfaWQiOjk4MDI0MzIzNSwiY3JlYXRlZF9hdCI6IjIwMjMtMDQtMDVUMTQ6NTQ6MDkuMzE3MTMxWiIsImlzX3RoaXJkX3BhcnR5X2FjY2VzcyI6dHJ1ZX0.d4_rVD2aR7LFpDrkvylmzR1M_MeVlg48hIbtYZtGBGE';
const IMOBZI_BASE_URL = 'https://api.imobzi.app/v1';

// Configurações Supabase (PostgreSQL) - Usando Pool para melhor gestão de conexões
const pool = new Pool({
    host: 'aws-1-us-east-1.pooler.supabase.com',
    port: 6543,
    user: 'postgres.tkuhoyzktoogbybgomfy',
    password: 'imobx110398',
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 100, // Máximo de conexões simultâneas no pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// IDs Fixos
const COMPANY_ID = '13b0ff9c-10e4-4abc-9fd8-313ecc1d132c';
const RESPONSIBLE_USER_ID = '629e6552-86a7-4234-bfc0-ad2bd02bad9d';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Utilitários de Limpeza e Mapeamento
 */
const cleanHtml = (rawHtml) => (rawHtml || "").replace(/<br\s*\/?>/gi, '\n').replace(/<.*?>/g, '').replace(/&nbsp;/g, ' ').trim();

const mapPropertyType = (imobziType) => {
    const mapping = {
        'Casa': 'house', 'Casa em Condomínio': 'house', 'Apartamento': 'apartment',
        'Terreno': 'land', 'Comercial': 'commercial', 'Chácara': 'rural',
        'Sítio': 'rural', 'Fazenda': 'rural'
    };
    return mapping[imobziType] || 'house';
};

const mapPropertyStatus = (imobziStatus) => {
    const mapping = { 'available': 'available', 'rented': 'rented', 'solded': 'sold', 'pending': 'maintenance' };
    return mapping[imobziStatus] || 'available';
};

/**
 * Garante estrutura do banco com índices para performance e integridade
 */
async function setupDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Adicionar colunas se não existirem
        const columns = [
            { name: 'imobzi_id', type: 'VARCHAR' },
            { name: 'imobzi_code', type: 'VARCHAR' },
            { name: 'imobzi_url', type: 'TEXT' }
        ];
        
        for (const col of columns) {
            await client.query(`
                DO $$ BEGIN 
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='properties' AND column_name='${col.name}') THEN
                        ALTER TABLE properties ADD COLUMN ${col.name} ${col.type};
                    END IF;
                END $$;
            `);
        }

        // Índices Únicos para UPSERT eficiente
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_company_imobzi_id 
            ON properties("companyId", imobzi_id) WHERE imobzi_id IS NOT NULL;
        `);

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Busca todas as propriedades (resumo) de forma paginada
 */
async function fetchAllProperties() {
    let allProps = [];
    const smartLists = ['all', 'inactives', 'pending'];
    const headers = { 'X-Imobzi-Secret': IMOBZI_API_SECRET };

    for (const slist of smartLists) {
        let cursor = null;
        let pageCount = 0;
        const maxPages = 1000; // Limite de segurança para evitar loop infinito
        
        console.log(`\nIniciando busca da lista: ${slist}`);
        
        while (pageCount < maxPages) {
            // Adicionar parâmetro limit para tentar aumentar itens por página
            // Se a API não aceitar, vai usar o padrão (10)
            let url = `${IMOBZI_BASE_URL}/properties?smart_list=${slist}&limit=50`;
            if (cursor) url += `&cursor=${cursor}`;
            
            let success = false;
            let retries = 0;
            const maxRetries = 5;
            
            while (!success && retries < maxRetries) {
                try {
                    console.log(`  Página ${pageCount + 1} da lista ${slist}${cursor ? ` (cursor: ${cursor.substring(0, 20)}...)` : ''}`);
                    
                    const response = await axios.get(url, { 
                        headers,
                        timeout: 30000 // 30 segundos de timeout
                    });
                    
                    const data = response.data;
                    const props = data.properties || [];
                    allProps = allProps.concat(props);
                    
                    console.log(`  ✓ ${props.length} propriedades encontradas (Total acumulado: ${allProps.length})`);
                    
                    cursor = data.cursor;
                    success = true;
                    pageCount++;
                    
                    if (!cursor) {
                        console.log(`  Lista ${slist} concluída. Total: ${allProps.length} propriedades.`);
                        break;
                    }
                    
                    // Pausa entre requisições
                    await sleep(500);
                    
                } catch (error) {
                    retries++;
                    const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
                    const is504 = error.response?.status === 504;
                    const is503 = error.response?.status === 503;
                    
                    if (isTimeout || is504 || is503) {
                        const waitTime = Math.min(2000 * retries, 10000); // Backoff até 10s
                        console.log(`  ⚠ Erro ${error.response?.status || 'timeout'} na página ${pageCount + 1} (tentativa ${retries}/${maxRetries}). Aguardando ${waitTime}ms...`);
                        await sleep(waitTime);
                    } else {
                        console.error(`  ✗ Erro ao buscar lista ${slist}, página ${pageCount + 1}: ${error.message}`);
                        if (retries >= maxRetries) {
                            console.log(`  ⚠ Pulando lista ${slist} após ${maxRetries} tentativas falhadas.`);
                            break;
                        }
                        await sleep(1000 * retries);
                    }
                }
            }
            
            if (!success || !cursor) {
                break;
            }
        }
        
        if (pageCount >= maxPages) {
            console.log(`  ⚠ Limite de páginas atingido para lista ${slist}. Continuando...`);
        }
    }
    
    console.log(`\n✓ Busca concluída. Total de ${allProps.length} propriedades encontradas.`);
    return allProps;
}

/**
 * Busca detalhes com Retry e Timeout
 */
async function fetchDetails(propId, retries = 3) {
    const headers = { 'X-Imobzi-Secret': IMOBZI_API_SECRET };
    for (let i = 0; i < retries; i++) {
        try {
            const { data } = await axios.get(`${IMOBZI_BASE_URL}/property/${propId}`, { headers, timeout: 15000 });
            return data;
        } catch (e) {
            if (i === retries - 1) return null;
            await sleep(1000 * (i + 1));
        }
    }
}

/**
 * Processa um imóvel individualmente usando UPSERT e Transação
 * Double check: Se o imóvel está "available" no Imobzi, mantém/insere. Senão, desativa no DB.
 */
async function processProperty(details, stats) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Só inserir/atualizar como ativo se estiver "available" na API
        const isAvailable = details.status === 'available';
        
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
            features: JSON.stringify(details.nearby || []),
            // Se estiver available, mantém ativo. Senão, desativa no DB
            isActive: isAvailable && (details.active !== false),
            companyId: COMPANY_ID,
            responsibleUserId: RESPONSIBLE_USER_ID,
            code: details.code,
            imobzi_id: String(details.db_id),
            imobzi_code: details.code,
            imobzi_url: details.site_url,
            updated_at: new Date()
        };

        const cols = Object.keys(propData);
        const vals = Object.values(propData);
        
        // UPSERT: Insere ou atualiza se o imobzi_id já existir para aquela empresa
        const query = `
            INSERT INTO properties (${cols.map(c => `"${c}"`).join(', ')})
            VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT ("companyId", imobzi_id) 
            DO UPDATE SET ${cols.filter(c => c !== 'companyId' && c !== 'imobzi_id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}
            RETURNING id, (xmax = 0) AS is_insert;
        `;

        const res = await client.query(query, vals);
        const propertyUuid = res.rows[0].id;
        res.rows[0].is_insert ? stats.inserted++ : stats.updated++;

        // Processar Fotos em Lote
        const photos = (details.photos && details.photos.photos) || [];
        if (photos.length > 0) {
            for (const photo of photos) {
                const fileName = photo.db_id.toString();
                await client.query(`
                    INSERT INTO gallery_images 
                    (original_name, file_name, file_path, file_url, file_size, mime_type, file_extension, status, category, company_id, property_id, display_order, is_main, aws_bucket, aws_key, aws_region)
                    VALUES ($1, $2, $3, $4, 0, 'image/jpeg', 'jpg', 'active', 'general', $5, $6, $7, $8, 'migrated', 'migrated', 'us-east-1')
                    ON CONFLICT DO NOTHING
                `, [photo.url.split('/').pop().substring(0, 255), fileName, photo.url, photo.url, COMPANY_ID, propertyUuid, photo.position || 0, photo.position === 1]);
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Erro no imóvel ${details.db_id}: ${error.message}`);
        stats.errors++;
    } finally {
        client.release();
    }
}

/**
 * Inativa no DB um imóvel pelo imobzi_id (quando está na API mas não está "available")
 */
async function deactivateIfExists(imobziId, stats) {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE properties SET "isActive" = false, updated_at = $1 
             WHERE "companyId" = $2 AND imobzi_id = $3`,
            [new Date(), COMPANY_ID, String(imobziId)]
        );
    } finally {
        client.release();
    }
}

/**
 * Inativa no DB os imóveis cujo imobzi_id não está na lista retornada pela API
 */
async function deactivateNotInApi(imobziIdsFromApi) {
    if (imobziIdsFromApi.length === 0) return;
    const client = await pool.connect();
    try {
        const placeholders = imobziIdsFromApi.map((_, i) => `$${i + 3}`).join(', ');
        const result = await client.query(
            `UPDATE properties SET "isActive" = false, updated_at = $1 
             WHERE "companyId" = $2 AND imobzi_id IS NOT NULL AND imobzi_id NOT IN (${placeholders})`,
            [new Date(), COMPANY_ID, ...imobziIdsFromApi]
        );
        if (result.rowCount > 0) {
            console.log(`\n✓ ${result.rowCount} imóvel(is) inativado(s) no DB (não estão na API).`);
        }
    } finally {
        client.release();
    }
}

/**
 * Função Principal: buscar na API, inserir somente ativas, inativar o que não tiver na API
 */
async function migrate() {
    console.log("Iniciando migração: buscar na API, inserir somente ativas, inativar o que não tiver na API.");
    await setupDatabase();

    const properties = await fetchAllProperties();
    console.log(`Total: ${properties.length} imóveis encontrados na API.`);

    const imobziIdsFromApi = properties.map(p => String(p.db_id));
    const checkpointPath = 'migration_checkpoint.json';
    let processedIds = fs.existsSync(checkpointPath) ? new Set(JSON.parse(fs.readFileSync(checkpointPath)).ids) : new Set();
    
    let stats = { inserted: 0, updated: 0, errors: 0, skippedInactive: 0 };
    const CONCURRENCY_LIMIT = 100;
    let lastCheckpointSize = processedIds.size;

    for (let i = 0; i < properties.length; i += CONCURRENCY_LIMIT) {
        const batch = properties.slice(i, i + CONCURRENCY_LIMIT).filter(p => !processedIds.has(String(p.db_id)));
        
        await Promise.all(batch.map(async (p) => {
            const details = await fetchDetails(p.db_id);
            if (details) {
                if (details.status === 'available') {
                    await processProperty(details, stats);
                } else {
                    await deactivateIfExists(p.db_id, stats);
                    stats.skippedInactive++;
                }
                processedIds.add(String(p.db_id));
            } else {
                stats.errors++;
            }
        }));

        if (processedIds.size - lastCheckpointSize >= 100) {
            fs.writeFileSync(checkpointPath, JSON.stringify({ ids: Array.from(processedIds) }));
            lastCheckpointSize = processedIds.size;
        }
        
        process.stdout.write(`\rProgresso: ${processedIds.size}/${properties.length} | I: ${stats.inserted} U: ${stats.updated} inativos: ${stats.skippedInactive} E: ${stats.errors}`);
    }
    
    fs.writeFileSync(checkpointPath, JSON.stringify({ ids: Array.from(processedIds) }));

    await deactivateNotInApi(imobziIdsFromApi);

    console.log("\nMigração finalizada.");
    await pool.end();
}

migrate().catch(err => {
    console.error("\nErro fatal:", err);
    pool.end();
});

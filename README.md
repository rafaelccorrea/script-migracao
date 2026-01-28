# Script de Migração Imobzi para Supabase

Script Node.js para migrar propriedades da API Imobzi para o banco de dados Supabase (PostgreSQL).

## Características

- ✅ Busca automática de todas as propriedades (all, inactives, pending)
- ✅ Detecção automática de parâmetros de paginação da API
- ✅ Processamento paralelo (100 propriedades simultâneas)
- ✅ Sistema de checkpoint para continuar de onde parou
- ✅ Proteção contra duplicação (verificação por código e imobzi_id)
- ✅ Retry automático com backoff exponencial
- ✅ Reconexão automática ao banco de dados
- ✅ Logs detalhados de progresso

## Instalação

```bash
npm install
```

## Configuração

Edite as configurações no início do arquivo `migrate_imobzi.js`:

- `IMOBZI_API_SECRET`: Seu token de API do Imobzi
- `DB_CONFIG`: Configurações do banco Supabase

## Uso

```bash
node migrate_imobzi.js
```

## Funcionalidades

### Sistema de Checkpoint
O script salva automaticamente o progresso em `migration_checkpoint.json`. Se interrompido, pode ser reiniciado e continuará de onde parou.

### Proteção contra Duplicação
- Verificação dupla por `code` e `imobzi_id`
- Índices únicos no banco de dados
- Tratamento de erros de duplicação

### Performance
- Processa 100 propriedades simultaneamente
- Pool de 100 conexões com o banco
- Checkpoint otimizado (salva a cada 100 propriedades)

## Estrutura

- `migrate_imobzi.js`: Script principal
- `migration_checkpoint.json`: Arquivo de checkpoint (gerado automaticamente)
- `migration_errors.log`: Log de erros (gerado automaticamente)

## Notas

- O script detecta automaticamente se a API aceita parâmetros de paginação maiores
- Se a API não suportar, usa o padrão (10 propriedades por página)
- Erros são registrados em `migration_errors.log`

#!/usr/bin/env node

/**
 * CLI utility for managing tenants in Soundcast multi-tenant system
 * Usage:
 *   node src/cli/manage.js create-tenant <name> <api-key>
 *   node src/cli/manage.js list-tenants
 *   node src/cli/manage.js list-rooms <tenant-id>
 */

import { initDatabase } from '../db/database.js';
import { createTenant, listTenants, getTenantById } from '../db/models/tenant.js';
import { listRoomsByTenant } from '../db/models/room.js';
import { listInterpretersByRoom } from '../db/models/interpreter.js';

// Initialize database
const dbPath = process.env.DB_PATH || './soundcast.db';
initDatabase(dbPath);

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'create-tenant': {
    if (args.length < 2) {
      console.error('Usage: node src/cli/manage.js create-tenant <name> <api-key>');
      process.exit(1);
    }

    const [name, apiKey] = args;

    try {
      const tenant = createTenant(name, apiKey);
      console.log('✅ Tenant created successfully!');
      console.log(JSON.stringify(tenant, null, 2));
      console.log('\n🔑 API Key (save this!):', apiKey);
    } catch (error) {
      console.error('❌ Error creating tenant:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'list-tenants': {
    try {
      const tenants = listTenants();
      console.log('📋 Tenants:');
      console.log(JSON.stringify(tenants, null, 2));
    } catch (error) {
      console.error('❌ Error listing tenants:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'list-rooms': {
    if (args.length < 1) {
      console.error('Usage: node src/cli/manage.js list-rooms <tenant-id>');
      process.exit(1);
    }

    const tenantId = parseInt(args[0]);

    try {
      const tenant = getTenantById(tenantId);
      if (!tenant) {
        console.error(`❌ Tenant with ID ${tenantId} not found`);
        process.exit(1);
      }

      console.log(`📋 Rooms for tenant: ${tenant.name} (ID: ${tenant.id})`);
      const rooms = listRoomsByTenant(tenantId);
      console.log(JSON.stringify(rooms, null, 2));
    } catch (error) {
      console.error('❌ Error listing rooms:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'list-interpreters': {
    if (args.length < 1) {
      console.error('Usage: node src/cli/manage.js list-interpreters <room-id>');
      process.exit(1);
    }

    const roomId = parseInt(args[0]);

    try {
      console.log(`📋 Interpreters for room ID: ${roomId}`);
      const interpreters = listInterpretersByRoom(roomId);
      console.log(JSON.stringify(interpreters, null, 2));
    } catch (error) {
      console.error('❌ Error listing interpreters:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'help':
  default:
    console.log('Soundcast Multi-Tenant CLI Management Tool');
    console.log('');
    console.log('Commands:');
    console.log('  create-tenant <name> <api-key>    Create a new tenant');
    console.log('  list-tenants                      List all tenants');
    console.log('  list-rooms <tenant-id>            List rooms for a tenant');
    console.log('  list-interpreters <room-id>       List interpreters for a room');
    console.log('  help                              Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node src/cli/manage.js create-tenant "Acme Corp" "my-secret-key-123"');
    console.log('  node src/cli/manage.js list-tenants');
    console.log('  node src/cli/manage.js list-rooms 1');
    console.log('  node src/cli/manage.js list-interpreters 1');
    break;
}

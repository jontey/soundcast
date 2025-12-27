#!/usr/bin/env node

/**
 * CLI utility for managing tenants in Soundcast multi-tenant system
 * Usage:
 *   node src/cli/manage.js create-tenant <name> <api-key>
 *   node src/cli/manage.js list-tenants
 *   node src/cli/manage.js list-rooms <tenant-id>
 */

import { initDatabase } from '../db/database.js';
import { createTenant, listTenants, getTenantById, getTenantByName, updateTenantApiKey } from '../db/models/tenant.js';
import { listRoomsByTenant, getRoomById } from '../db/models/room.js';
import { createPublisher, listPublishersByRoom } from '../db/models/publisher.js';

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

  case 'create-publisher': {
    if (args.length < 3) {
      console.error('Usage: node src/cli/manage.js create-publisher <room-id> <channel-name> <name>');
      process.exit(1);
    }

    const roomId = parseInt(args[0]);
    const channel_name = args[1];
    const name = args.slice(2).join(' ');

    try {
      const room = getRoomById(roomId);
      if (!room) {
        console.error(`Room with ID ${roomId} not found`);
        process.exit(1);
      }

      const publisher = createPublisher({ room_id: roomId, name, channel_name });
      console.log('Publisher created successfully!');
      console.log(JSON.stringify({
        id: publisher.id,
        room_id: publisher.room_id,
        name: publisher.name,
        channel_name: publisher.channel_name,
        created_at: publisher.created_at
      }, null, 2));
      console.log('\nJoin Token (save this!):', publisher.join_token);
      console.log(`\nPublisher URL: /room/${room.slug}/publish?token=${publisher.join_token}`);
    } catch (error) {
      console.error('Error creating publisher:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'list-publishers': {
    if (args.length < 1) {
      console.error('Usage: node src/cli/manage.js list-publishers <room-id>');
      process.exit(1);
    }

    const roomId = parseInt(args[0]);

    try {
      console.log(`Publishers for room ID: ${roomId}`);
      const publishers = listPublishersByRoom(roomId);
      console.log(JSON.stringify(publishers, null, 2));
    } catch (error) {
      console.error('Error listing publishers:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'update-api-key': {
    if (args.length < 2) {
      console.error('Usage: node src/cli/manage.js update-api-key <tenant-name> <new-api-key>');
      process.exit(1);
    }

    const tenantName = args[0];
    const newApiKey = args[1];

    try {
      const tenant = getTenantByName(tenantName);
      if (!tenant) {
        console.error(`Tenant "${tenantName}" not found`);
        process.exit(1);
      }

      const updated = updateTenantApiKey(tenant.id, newApiKey);
      if (updated) {
        console.log(`API key updated successfully for tenant: ${tenant.name}`);
        console.log('New API Key:', newApiKey);
      } else {
        console.error('Failed to update API key');
        process.exit(1);
      }
    } catch (error) {
      console.error('Error updating API key:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'help':
  default:
    console.log('Soundcast Multi-Tenant CLI Management Tool');
    console.log('');
    console.log('Commands:');
    console.log('  create-tenant <name> <api-key>                     Create a new tenant');
    console.log('  list-tenants                                       List all tenants');
    console.log('  update-api-key <tenant-name> <new-api-key>         Update tenant API key');
    console.log('  list-rooms <tenant-id>                             List rooms for a tenant');
    console.log('  create-publisher <room-id> <channel-name> <name>   Create a publisher for a room');
    console.log('  list-publishers <room-id>                          List publishers for a room');
    console.log('  help                                               Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node src/cli/manage.js create-tenant "Acme Corp" "my-secret-key-123"');
    console.log('  node src/cli/manage.js list-tenants');
    console.log('  node src/cli/manage.js update-api-key "Acme Corp" "new-secret-key-456"');
    console.log('  node src/cli/manage.js list-rooms 1');
    console.log('  node src/cli/manage.js create-publisher 1 main "Main Speaker"');
    console.log('  node src/cli/manage.js list-publishers 1');
    break;
}

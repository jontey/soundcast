#!/usr/bin/env node

/**
 * CLI utility for managing Soundcast rooms and publishers
 * Usage:
 *   node src/cli/manage.js create-room <name> [slug]
 *   node src/cli/manage.js list-rooms
 *   node src/cli/manage.js create-publisher <room-id> <channel-name> <name>
 *   node src/cli/manage.js list-publishers <room-id>
 */

import { initDatabase } from '../db/database.js';
import { listAllRooms, getRoomById, createRoom } from '../db/models/room.js';
import { createPublisher, listPublishersByRoom } from '../db/models/publisher.js';

// Initialize database
const dbPath = process.env.DB_PATH || './soundcast.db';
initDatabase(dbPath);

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'create-room': {
    if (args.length < 1) {
      console.error('Usage: node src/cli/manage.js create-room <name> [slug]');
      process.exit(1);
    }

    const name = args[0];
    const slug = args[1];

    try {
      const room = createRoom({ name, slug });
      console.log('Room created successfully!');
      console.log(JSON.stringify({
        id: room.id,
        name: room.name,
        slug: room.slug,
        created_at: room.created_at
      }, null, 2));
    } catch (error) {
      console.error('Error creating room:', error.message);
      process.exit(1);
    }
    break;
  }

  case 'list-rooms': {
    try {
      const rooms = listAllRooms();
      console.log('Rooms:');
      console.log(JSON.stringify(rooms, null, 2));
    } catch (error) {
      console.error('Error listing rooms:', error.message);
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

  case 'help':
  default:
    console.log('Soundcast CLI Management Tool');
    console.log('');
    console.log('Commands:');
    console.log('  create-room <name> [slug]                          Create a new room');
    console.log('  list-rooms                                         List all rooms');
    console.log('  create-publisher <room-id> <channel-name> <name>   Create a publisher for a room');
    console.log('  list-publishers <room-id>                          List publishers for a room');
    console.log('  help                                               Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node src/cli/manage.js create-room "Main Stage" main');
    console.log('  node src/cli/manage.js list-rooms');
    console.log('  node src/cli/manage.js create-publisher 1 main "Main Speaker"');
    console.log('  node src/cli/manage.js list-publishers 1');
    break;
}
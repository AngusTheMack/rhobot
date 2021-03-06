const {
  buildCommand: buildNestedCommand,
  formatErrors,
} = require("./nestedCommand");
const RhobotDynamoDB = require("./dynamodb").RhobotDynamoDB;
const Discord = require("discord.js");
const DateTime = require("luxon").DateTime;

/**
 * Builds the Event command.
 *
 * This allows users to create events, which other users can sign up for.
 *
 * @param {string} prefix - the command prefix (everything that comes before this command)
 * @param {string} ddbTable - the DynamoDB table that stores events
 * @param {string} ddbRegion - the AWS region in which the DynamoDB table resides
 */
const buildCommand = (prefix, ddbTable, ddbRegion) => {
  const dao = new EventDao(ddbTable, ddbRegion);

  const commands = {
    create: buildCreateCommand(dao),
    delete: buildDeleteCommand(dao),
    list: buildListCommand(dao),
  };
  return buildNestedCommand(
    prefix,
    "event",
    "Create and manage events.",
    commands
  );
};

/**
 * Command that can create a new event.
 *
 * @param {EventDao} dao - an instance of Event DAO
 */
function buildCreateCommand(dao) {
  return {
    run: (message, parameters) => {
      const {
        errors,
        title,
        startTime,
        maxParticipants,
        setup,
      } = parseCreateEventParams(parameters);
      if (errors.length > 0) {
        message.reply(formatErrors(errors));
        return;
      }

      const channelId = message.channel.id;

      // Create a new Discord message - this will be the home of the event
      message.channel.send(Event.formatLoading()).then((eventMessage) => {
        console.log(setup);
        const event = new Event({
          // Use the event's Discord message's ID as the uuid - this will make it possible to reference later
          id: eventMessage.id,
          title,
          startTime,
          createdBy: message.author.username,
          maxParticipants,
          setup,
          created: DateTime.utc().toISO(),
        });

        return createEvent(
          dao,
          channelId,
          eventMessage,
          event
        ).catch((reason) =>
          eventMessage.edit("[ERROR] Unable to create new event: " + reason)
        );
      });
    },
    help: "Create a new event.",
  };
}

/**
 * Save the event details and format the event.
 *
 * @param {EventDao} dao - Dao object
 * @param {string} channelId - the Discord Channel ID
 * @param {Discord.Message} eventMessage - the Discord message hosting the event
 * @param {Event} event - the event object
 */
function createEvent(dao, channelId, eventMessage, event) {
  return dao
    .updateEvent(channelId, event)
    .then(function updateMessageWithEventDetails() {
      return dao.readEvent(channelId, event.id).then((event) =>
        eventMessage
          .edit(event.format())
          // Add default reactions which users can use to join
          .then(() => eventMessage.react("✅"))
          .then(() => eventMessage.react("🚫"))
      );
    })
    .catch((error) =>
      eventMessage.edit("Issue reading event " + event.id + ": " + error)
    );
}

/**
 * Parses and validates parameters for the create subcommand.
 *
 * @param {string[]} parameters - the subcommand parameters.
 */
function parseCreateEventParams(parameters) {
  const result = parseParameters(parameters);

  if (!result.title) {
    result.errors.push("Event title must be specified with `--title`");
  }

  if (!result.startTime) {
    result.errors.push("Event start time must be specified with `--startTime`");
  } else if (DateTime.fromISO(result.startTime).invalid) {
    result.errors.push("Event start time must be ISO-8601 compatible.");
  }

  if (result.maxParticipants && isNaN(parseInt(result.maxParticipants))) {
    result.errors.push("Max participants must be an integer.");
  }

  if (result.setup) {
    console.log("The setup commands are: " + result.setup);
  }

  return result;
}

/**
 * Command that shows upcoming events.
 *
 * @param {EventDao} dao - an instance of Event DAO
 */
function buildListCommand(dao) {
  return {
    run: (message, _parameters) => {
      const channel = message.channel;
      const now = DateTime.utc();
      const isUpcoming = (event) => DateTime.fromISO(event.startTime) > now;

      dao
        .readEvents(channel.id)
        // filter upcoming
        .then((events) => (events ? events.filter(isUpcoming) : []))
        // format results
        .then((events) => {
          message.channel.send(
            formatEvents(channel, "Upcoming events", events)
          );
        })
        .catch((error) =>
          message.reply("Issue reading upcoming events: " + error)
        );
    },
    help: "List upcoming events.",
  };
}

/**
 * Format a set of events
 *
 * @param {Discord.TextChannel | Discord.DMChannel} channel
 * @param {Event[]} events - events to format
 * @return {Discord.MessageEmbed} embed - the formatted embed
 */
function formatEvents(channel, title, events) {
  const guildId = channel.type === "dm" ? "@me" : channel.guild.id;

  const embed = new Discord.MessageEmbed();
  embed.setTitle(title);
  events.forEach((event) => {
    const eventLink = `${event.title}`;
    const relativeStartTime = DateTime.fromISO(event.startTime).toRelative();
    const field = `Starts ${relativeStartTime} - [link to event](https://discordapp.com/channels/${guildId}/${channel.id}/${event.id})`;
    embed.addField(eventLink, field);
  });
  embed.setFooter(
    events.length > 0
      ? "Event details can be found on the original post. Follow the links to get there."
      : "No upcoming events found."
  );

  return embed;
}

/**
 * Command that can delete an event.
 *
 * @param {EventDao} dao - an instance of Event DAO
 */
function buildDeleteCommand(dao) {
  return {
    run: (message, parameters) => {
      const { errors, id } = parseDeleteEventParams(parameters);
      if (errors.length > 0) {
        message.reply(formatErrors(errors));
        return;
      }

      const channelId = message.channel.id;

      // Find the Discord message
      message.channel.messages
        .fetch(id)
        // Then delete
        .then((eventMessage) => {
          dao
            .deleteEvent(channelId, id)
            // Then update the discord message
            .then(() => {
              eventMessage.edit(Event.formatDeleted());
              eventMessage.reactions.removeAll();
              message.reply(`Event ${id} has been successfully deleted.`);
            });
        })
        .catch((reason) =>
          message.reply(`[ERROR] Unable to delete event ${id}:` + reason)
        );
    },
    help: "Delete an event.",
  };
}

/**
 * Parses and validates parameters for the create subcommand.
 *
 * @param {string[]} parameters - the subcommand parameters.
 */
function parseDeleteEventParams(parameters) {
  const result = parseParameters(parameters);

  if (!result.id) {
    result.errors.push("Event ID must be specified with `--id`");
  }

  return result;
}

/**
 * Finds the setup description in the parameters
 *
 * @param {string[]} remainingParameters - what comes after the --setup command
 */
function findSetup(remainingParameters) {
  let setup = "";
  for (let i = 0; i < remainingParameters.length; i++) {
    let currentWord = remainingParameters[i];
    if (currentWord.includes("--")) {
      return setup;
    } else {
      setup += currentWord + " ";
    }
  }
  return setup;
}

/**
 * Pulls out known parameters for the event command.
 *
 * @param {string[]} parameters - the command parameters
 */
function parseParameters(parameters) {
  const result = { errors: [] };
  console.log(parameters);
  while (parameters.length) {
    const option = parameters.shift();
    switch (option) {
      case "--title":
        result.title = parameters.shift();
        break;
      case "--startTime":
        result.startTime = parameters.shift();
        break;
      case "--maxParticipants":
        result.maxParticipants = parameters.shift();
        break;
      case "--id":
        result.id = parameters.shift();
        break;
      case "--setup":
        let setup = "";
        while (parameters.length > 0) {
          let currentWord = parameters.shift();
          if (currentWord.includes("--")) {
            parameters.unshift(currentWord);
            break;
          } else {
            setup += currentWord + " ";
          }
        }
        result.setup = setup.trimRight();
        break;
      default:
        result.errors.push(`Unrecognized option: ${option}`);
        break;
    }
  }
  console.log(result);
  return result;
}

class EventDao {
  static DATABASE_ITEM_TYPE = "event";
  ddb;

  /**
   * Data access object for Events.
   *
   * @param {string} ddbTable - the DynamoDB table that stores events
   * @param {string} ddbRegion - the AWS region in which the DynamoDB table resides
   */
  constructor(ddbTable, ddbRegion) {
    this.ddb = new RhobotDynamoDB(ddbTable, ddbRegion);
  }

  /**
   * Save an event to DynamoDB.
   *
   * @param {Event} event
   * @return {Promise<string>} id - the ID of the committed record
   */
  updateEvent(channelId, event) {
    const attributes = EventDao.eventToAttributes(event);
    return this.ddb
      .put(channelId, EventDao.DATABASE_ITEM_TYPE, attributes)
      .then(() => event.id);
  }

  /**
   * Read an event from DynamoDB.
   *
   * @param {string} channelId - the Discord channel ID
   * @param {string} id - the event identifier
   * @return {Promise<Event>} result - the event read from DynamoDB
   */
  readEvent(channelId, id) {
    return this.ddb
      .readItem(channelId, EventDao.DATABASE_ITEM_TYPE, id)
      .then((result) => EventDao.attributesToEvent(result.Item));
  }

  /**
   * Delete an event from DynamoDB.
   *
   * @param {string} channelId - the Discord channel ID
   * @param {string} id - the event identifier
   * @return {Promise<void>}  the event read from DynamoDB
   */
  deleteEvent(channelId, id) {
    return this.ddb
      .delete(channelId, EventDao.DATABASE_ITEM_TYPE, id)
      .then(() => {});
  }

  /**
   * Read all events for this channel from DynamoDB.
   *
   * @param {string} channelId
   * @return {Promise<Event[]>} events - the events from DynamoDB
   */
  readEvents(channelId) {
    return this.ddb
      .readType(channelId, EventDao.DATABASE_ITEM_TYPE)
      .then((result) => result.Items.map(EventDao.attributesToEvent));
  }

  /**
   * Transform an event object into DynamoDB item attributes.
   *
   * @param {Event} event - the event object
   * @returns {AWS.DynamoDB.AttributeMap}
   */
  static eventToAttributes({
    id,
    title,
    startTime,
    createdBy,
    created,
    maxParticipants,
    setup,
  }) {
    const attributes = {
      uuid: { S: id },
      Title: { S: title },
      StartTime: { S: startTime },
      CreatedBy: { S: createdBy },
      Created: { S: created },
    };

    if (maxParticipants) {
      attributes["MaxParticipants"] = { N: maxParticipants };
    }

    if (setup) {
      attributes["Setup"] = { S: setup };
    }

    return attributes;
  }

  /**
   * Transform DynamoDB item attributes into an Event object.
   *
   * @param {AWS.DynamoDB.AttributeMap} attributes - DynamoDB item attributes
   * @returns the corresponding Event object
   */
  static attributesToEvent({
    uuid,
    Title,
    StartTime,
    CreatedBy,
    Created,
    MaxParticipants,
    Setup,
  }) {
    const params = {
      id: uuid.S,
      title: Title.S,
      startTime: StartTime.S,
      createdBy: CreatedBy.S,
      created: Created.S,
    };

    if (MaxParticipants) {
      params.maxParticipants = MaxParticipants.N;
    }

    if (Setup) {
      params.setup = Setup.S;
    }

    return new Event(params);
  }
}

class Event {
  id;
  title;
  startTime;
  createdBy;
  created;
  maxParticipants;
  setup;

  /**
   * Models an event.
   *
   * @param {string} id - the unique ID of the event
   * @param {string} title - the event title
   * @param {string} startTime - the event start time (ISO-8601 string)
   * @param {string} createdBy - name of user who created the event
   * @param {string} created - the time at which the event was created (ISO-8601 string)
   * @param {string} maxParticipants - the maximum number of participants
   * @param {string} setup - the instructions to setup the game for the event
   */
  constructor({ id, title, startTime, createdBy, created, maxParticipants }) {
    this.id = id;
    this.title = title;
    this.startTime = startTime;
    this.createdBy = createdBy;
    this.created = created;
    this.maxParticipants = maxParticipants;
    this.setup = setup;
  }

  format() {
    try {
      const embed = new Discord.MessageEmbed()
        .setTitle("Event: " + this.title)
        .addField("Start time", formatDate(this.startTime))
        .addField("Create time", formatDate(this.created))
        .addField("Created by", this.createdBy)
        .setFooter(`id: ${this.id}`);

      if (this.maxParticipants) {
        embed.addField("Max participants", this.maxParticipants);
      }
      if (this.setup) {
        embed.addField("Setup: ", this.setup);
      }
      return embed;
    } catch (err) {
      return new Discord.MessageEmbed()
        .setTitle("Error formatting event")
        .setDescription("If this persists, please reach out to the bot admin.")
        .addField("Error", err.trace);
    }
  }

  static formatLoading() {
    const embed = new Discord.MessageEmbed()
      .setTitle("Creating new event...")
      .setFooter("Details will update once the event has been created.");
    return embed;
  }

  static formatDeleted() {
    const embed = new Discord.MessageEmbed()
      .setTitle("Event: 🗑️")
      .setFooter("This event has been deleted.");
    return embed;
  }
}

function formatDate(dateStr) {
  // TODO: make the timezone configurable
  const timezone = "UTC+2";
  return (
    DateTime.fromISO(dateStr)
      .setZone(timezone)
      .toFormat(`HH:mm EEEE yyyy-MM-dd `) + timezone
  );
}

module.exports = buildCommand;

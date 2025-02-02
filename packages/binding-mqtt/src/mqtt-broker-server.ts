/********************************************************************************
 * Copyright (c) 2018 - 2019 Contributors to the Eclipse Foundation
 * 
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 * 
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0, or the W3C Software Notice and
 * Document License (2015-05-13) which is available at
 * https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document.
 * 
 * SPDX-License-Identifier: EPL-2.0 OR W3C-20150513
 ********************************************************************************/

/**
 * MQTT Broker Server
 */

import { IPublishPacket } from "mqtt";
import * as mqtt from "mqtt";
import * as url from "url";

import * as TD from "@node-wot/td-tools";
import { ProtocolServer, Servient, ExposedThing, ContentSerdes } from "@node-wot/core";

export default class MqttBrokerServer implements ProtocolServer {

  readonly scheme: string = "mqtt";

  private port: number = -1;
  private address: string = undefined;

  private user: string = undefined; // in the case usesername is required to connect the broker

  private psw: string = undefined; // in the case password is required to connect the broker

  private clientId: string = undefined; // in the case clientId can be used to identify the device

  private protocolVersion: number = undefined;

  private brokerURI: string = undefined;

  private readonly things: Map<string, ExposedThing> = new Map<string, ExposedThing>();

  private broker: any;
  private rejectUnauthorized: boolean;

  /*new MqttBrokerServer(this.config.mqtt.broker,
                        (typeof this.config.mqtt.username === "string") ? this.config.mqtt.username : undefined,
                        (typeof this.config.mqtt.password === "string") ? this.config.mqtt.password : undefined,
                        (typeof this.config.mqtt.clientId === "string") ? this.config.mqtt.clientId : undefined);
  /*

  /*
        "port": BROKER-PORT,
        "version": MQTT_VERSION
  */
  constructor(uri: string, user?: string, psw?: string, clientId?: string, protocolVersion?: number, rejectUnauthorized?: boolean) {
    if (uri !== undefined) {

      //if there is a MQTT protocol identicator missing, add this
      if (uri.indexOf("://") == -1) {
        uri = this.scheme + "://" + uri;
      }
      this.brokerURI = uri;
    }

    if (user !== undefined) {
      this.user = user;
    }
    if (psw !== undefined) {
      this.psw = psw;
    }
    if (clientId !== undefined) {
      this.clientId = clientId;
    }
    if (protocolVersion !== undefined) {
      this.protocolVersion = protocolVersion;
    }

    this.rejectUnauthorized = rejectUnauthorized;
  }

  public expose(thing: ExposedThing): Promise<void> {

    if (this.broker === undefined) {
      return;
    }

    let name = thing.title;

    if (this.things.has(name)) {
      let suffix = name.match(/.+_([0-9]+)$/);
      if (suffix !== null) {
        name = name.slice(0, -suffix[1].length) + (1 + parseInt(suffix[1]));
      } else {
        name = name + "_2";
      }
    }

    console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} exposes '${thing.title}' as unique '${name}/*'`);
    return new Promise<void>((resolve, reject) => {
      
      this.things.set(name, thing);

      for (let propertyName in thing.properties) {
        let topic = encodeURIComponent(name) + "/properties/" + encodeURIComponent(propertyName);
        let property = thing.properties[propertyName];

        if(!property.writeOnly ){
          thing.observeProperty(propertyName,
          // let subscription = property.subscribe(
            (data) => {
              let content;
              try {
                content = ContentSerdes.get().valueToContent(data, property.data);
              } catch(err) {
                console.warn("[binding-mqtt]",`MqttServer cannot process data for Property '${propertyName}': ${err.message}`);
                // subscription.unsubscribe();
                thing.unobserveProperty(propertyName);
                return;
              }
              console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} publishing to Property topic '${propertyName}' `);
              this.broker.publish(topic, content.body,{retain:true});
            }
          );

          let href = this.brokerURI + "/" + topic;
          let form = new TD.Form(href, ContentSerdes.DEFAULT);
          form.op = ["readproperty","observeproperty", "unobserveproperty"];
          thing.properties[propertyName].forms.push(form);
          console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} assigns '${href}' to property '${propertyName}'`);

        }
        if(!property.readOnly){

          let href = this.brokerURI + "/" + topic +"/writeproperty";
          this.broker.subscribe(topic + "/writeproperty");
          let form = new TD.Form(href, ContentSerdes.DEFAULT);
          form.op = ["writeproperty"];
          thing.properties[propertyName].forms.push(form);
          console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} assigns '${href}' to property '${propertyName}'`);

        }
      }

      for (let actionName in thing.actions) {
        let topic = encodeURIComponent(name) + "/actions/" + encodeURIComponent(actionName);
        this.broker.subscribe(topic);

        let href = this.brokerURI + "/" + topic;
        let form = new TD.Form(href, ContentSerdes.DEFAULT);
        form.op = ["invokeaction"];
        thing.actions[actionName].forms.push(form);
        console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} assigns '${href}' to Action '${actionName}'`);
      }

      // connect incoming messages to Thing
      this.broker.on("message", (receivedTopic: string, rawPayload: Buffer | string, packet: IPublishPacket) => {

        // route request
        let segments = receivedTopic.split("/");
        let payload: Buffer;
        if (rawPayload instanceof Buffer) {
            payload = rawPayload;
        } else if (typeof rawPayload === "string") {
            payload = Buffer.from(rawPayload);
        }

        if (segments.length === 4 ) {
          // connecting to the actions
          console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} received message for '${receivedTopic}'`);
          let thing = this.things.get(segments[1]);
          if (thing) {
            if (segments[2] === "actions") {
              let action = thing.actions[segments[3]];
              let value;
              if (action) {
                /*
                 * Currently, this branch will never be taken. The main reason for that is in the mqtt library we use:
                 * https://github.com/mqttjs/MQTT.js/pull/1103
                 * For further discussion see https://github.com/eclipse/thingweb.node-wot/pull/253
                 */
                if ('properties' in packet && 'contentType' in packet.properties) {
                  try {
                    value = ContentSerdes.get().contentToValue({ type: packet.properties.contentType, body: payload }, action.input);
                  } catch(err) {
                    console.warn(`MqttBrokerServer at ${this.brokerURI} cannot process received message for '${segments[3]}': ${err.message}`);
                  }
                } else {
                  try {
                    value = JSON.parse(payload.toString());
                  } catch(err) {
                    console.warn(`MqttBrokerServer at ${this.brokerURI}, packet has no Content Type and does not parse as JSON, relaying raw (string) payload.`);
                    value = payload.toString();
                  }
                }
              }
              thing.invokeAction(segments[3], value)
              .then((output) => {
                // MQTT cannot return results
                if (output) {
                  console.warn(`MqttBrokerServer at ${this.brokerURI} cannot return output '${segments[3]}'`);
                }
              })
              .catch(err => {
                console.error(`MqttBrokerServer at ${this.brokerURI} got error on invoking '${segments[3]}': ${err.message}`);
              });

              // topic found and message processed
              return;
            } // Action exists?
          } // Thing exists?
        } else if(segments.length === 5 && segments[4] === "writeproperty" ){
          //connecting to the writeable properties
          let thing = this.things.get(segments[1]);
          if (thing) {
            if (segments[2] === "properties") {
              let property = thing.properties[segments[3]];
              if (property) {
                if(!property.readOnly){
                  thing.writeProperty(segments[3], JSON.parse(payload.toString()))
                    .catch(err => {
                      console.error("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} got error on writing to property '${segments[3]}': ${err.message}`);
                    });
                  // topic found and message processed
                  return;
                } else {
                  console.warn("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} received message for readOnly property at '${receivedTopic}'`);
                  return;
                } //property is writeable? Not necessary since it didn't actually subscribe to this topic
              } // Property exists?
            }
          }
          return;
        }
        // topic not found
        console.warn("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} received message for invalid topic '${receivedTopic}'`);
      });

      for (let eventName in thing.events) {
        let topic = encodeURIComponent(name) + "/events/" + encodeURIComponent(eventName);
        let event = thing.events[eventName];

        thing.subscribeEvent(eventName,
        // FIXME store subscription and clean up on stop
        // let subscription = event.subscribe(

          (data) => {
            let content;
            try {
              content = ContentSerdes.get().valueToContent(data, event.data);
            } catch(err) {
              console.warn("[binding-mqtt]",`HttpServer on port ${this.getPort()} cannot process data for Event '${eventName}: ${err.message}'`);
              // subscription.unsubscribe();
              thing.unsubscribeEvent(eventName);
              return;
            }
            // send event data
            console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} publishing to Event topic '${eventName}' `);
            this.broker.publish(topic, content.body);
          }
        );

        let href = this.brokerURI + "/" + topic;
        let form = new TD.Form(href, ContentSerdes.DEFAULT);
        form.op = ["subscribeevent", "unsubscribeevent"];
        event.forms.push(form);
        console.debug("[binding-mqtt]",`MqttBrokerServer at ${this.brokerURI} assigns '${href}' to Event '${eventName}'`);
      }
      this.broker.publish(name, JSON.stringify(thing.getThingDescription()),{retain:true,contentType:"application/td+json"});
      resolve();
    });
  }

  public destroy(thingId: string): Promise<boolean> {
    console.debug("[binding-mqtt]", `MqttBrokerServer on port ${this.getPort()} destroying thingId '${thingId}'`);
    return new Promise<boolean>((resolve, reject) => {
      let removedThing: ExposedThing = undefined;
      for (let name of Array.from(this.things.keys())) {
        let expThing = this.things.get(name);
        if (expThing != null && expThing.id != null && expThing.id === thingId) {
          this.things.delete(name);
          removedThing = expThing;
        }
      }
      if (removedThing) {
        console.info("[binding-mqtt]", `MqttBrokerServer succesfully destroyed '${removedThing.title}'`);
      } else {
        console.info("[binding-mqtt]", `MqttBrokerServer failed to destroy thing with thingId '${thingId}'`)
      }
      resolve(removedThing != undefined);
    });
  }

  public start(servient: Servient): Promise<void> {
    return new Promise<void>((resolve, reject) => {

      if (this.brokerURI === undefined) {
        console.warn("[binding-mqtt]",`No broker defined for MQTT server binding - skipping`);
        resolve();
      } else {
        // try to connect to the broker without or with credentials
        if (this.psw === undefined) {
          console.debug("[binding-mqtt]",`MqttBrokerServer trying to connect to broker at ${this.brokerURI}`);
        } else if (this.clientId === undefined) {
          console.debug("[binding-mqtt]",`MqttBrokerServer trying to connect to secured broker at ${this.brokerURI}`);
        } else if (this.protocolVersion === undefined) {
          console.debug("[binding-mqtt]",`MqttBrokerServer trying to connect to secured broker at ${this.brokerURI} with client ID ${this.clientId}`);
        } else {
          console.debug("[binding-mqtt]",`MqttBrokerServer trying to connect to secured broker at ${this.brokerURI} with client ID ${this.clientId}`);
        }
        // TODO test if mqtt extracts port from passed URI (this.address)
        this.broker = mqtt.connect(this.brokerURI, { username: this.user, password: this.psw, clientId: this.clientId, protocolVersion: this.protocolVersion, rejectUnauthorized: this.rejectUnauthorized });

        this.broker.on("connect", () => {
          console.info("[binding-mqtt]",`MqttBrokerServer connected to broker at ${this.brokerURI}`);

          let parsed = url.parse(this.brokerURI);
          this.address = parsed.hostname;
          let port = parseInt(parsed.port);
          this.port = port > 0 ? port : 1883;
          resolve();
        });
        this.broker.on("error", (error: Error) => {
          console.error("[binding-mqtt]",`MqttBrokerServer could not connect to broker at ${this.brokerURI}`);
          reject(error);
        });
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {

      if (this.broker === undefined) resolve();

      this.broker.stop();
    });
  }

  public getPort(): number {
    return this.port;
  }

  public getAddress(): string {
    return this.address;
  }
}

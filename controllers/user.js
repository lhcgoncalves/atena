"use strict";
import config from "config-yml";
import mongoose from "mongoose";
import { driver } from "@rocket.chat/sdk";
import moment from "moment";
import {
  calculateScore,
  calculateReceivedScore,
  calculateReactions,
  getUserInfo
} from "../utils";
import { isEligibleToPro } from "../utils/pro";
import { sendToUser } from "../rocket/bot";
import { _throw } from "../helpers";
import axios from "axios";
import { isValidToken } from "../utils/teams";
import interactionController from "./interaction";
import { getUserInfo as getRocketUserInfo } from "../rocket/api";
import api from "../rocket/api";
import userModel from "../models/user";
import { runPublisher } from "../workers/publisher";

const updateParentUser = async interaction => {
  const score = calculateReceivedScore(interaction);
  const userInfo = await getRocketUserInfo(interaction.parentUser);

  if (userInfo) {
    let user = await findByOrigin(interaction, true);

    user.pro = await handlePro(user);

    if (user) {
      if (score > 0) {
        const newScore = user.score + score;
        user.level = calculateLevel(newScore);
        user.score = newScore < 0 ? 0 : newScore;
        user.lastUpdate = Date.now();
        return await user.save();
      }
    } else {
      const UserModel = mongoose.model("User");
      return await createUserData(false, score, interaction, UserModel);
    }
  } else {
    throw new Error(`Error on finding parentUser on rocket`);
  }
};

const update = async interaction => {
  const score = calculateScore(interaction);

  const UserModel = mongoose.model("User");
  let user = {};
  let userInfo;

  if (interaction.origin === "slack" || !interaction.origin) {
    userInfo = await getUserInfo(interaction.user);
    user = await UserModel.findOne({ slackId: interaction.user }).exec();
  } else if (interaction.origin === "rocket") {
    userInfo = false;
    user = await UserModel.findOne({ rocketId: interaction.user }).exec();
  }

  user.pro = await handlePro(user);

  if (user.score === 0) {
    sendToUser(
      `Olá, Impulser! Eu sou *Atena*, deusa da sabedoria e guardiã deste reino! Se chegaste até aqui suponho que queiras juntar-se a nós, estou certa?! Vejo que tens potencial, mas terás que me provar que és capaz!

      Em meus domínios terás que realizar tarefas para mim, teus feitos irão render-te *Pontos de Experiência* que, além de fortalecer-te, permitirão que obtenhas medalhas de *Conquistas* em forma de reconhecimento! Sou uma deusa amorosa, por isso saibas que, eventualmente, irei premiar-te de maneira especial!

      No decorrer do tempo, sentirás a necessidade de acompanhar o teu progresso. Por isso, podes consultar os livros de nossa biblioteca que contém tudo o que fizestes até então, são eles:

      - Pergaminhos de *Pontos de Experiência: !meuspontos* ou */meuspontos*;

      - e os Tomos de *Conquistas: !minhasconquistas* ou */minhasconquistas*.

      Ah! Claro que não estás só na realização destas tarefas. Os nomes dos(as) Impulsers estão dispostos nos murais no exterior de meu templo, esta é uma forma de reconhecer o teu valor e os teusesforços. Lá, tu encontrarás dois murais:

      - O *!ranking* ou */ranking _nº do mês_* onde estão os nomes dos(das) que mais se esforçaram neste mês. Aquele(a) que estiver em primeiro lugar receberá uma recompensa especial;

      - e o *!rakinggeral* ou */rankinggeral* onde os nomes ficam dispostos, indicando -toda a sua contribuição realizada até o presente momento.

      Sei que são muitas informações, mas tome nota, para que não te esqueças de nada. Neste papiro, encontrarás *tudo o que precisa* saber em caso de dúvidas: **http://atena.impulso.network.**

      Espero que aproveite ao máximo *tua jornada* por aqui!`,
      interaction.rocketUsername
    );
  }

  if (user) {
    return await updateUserData(user, interaction, score);
  } else {
    return await createUserData(userInfo, score, interaction, UserModel);
  }
};

const customUpdate = async (user, interactionScore, interaction) => {
  // TODO: Remove argument interaction.
  // just added because function calculateReactions need that
  return userModel.findOne({ rocketId: user }).then((doc, err) => {
    if (err) {
      console.log("erro ao fazer update no usuario ", user, interactionScore);
    }
    const newScore = doc.score + interactionScore;
    doc.score = newScore;
    doc.level = calculateLevel(newScore);
    doc.reactions = calculateReactions(interaction, 0);
    return doc.save();
  });
};

const find = async (userId, isCoreTeam = false, selectOptions = "-email") => {
  // change find by slackId and release to rocketId too
  const UserModel = mongoose.model("User");
  const result = await UserModel.findOne({
    slackId: userId,
    isCoreTeam: isCoreTeam
  })
    .select(selectOptions)
    .exec();
  if (result) result.score = result.score.toFixed(0);

  return result || _throw("Error finding a specific user");
};

const findByOrigin = async (interaction, isParent = false) => {
  let query = {};
  let userId = isParent ? interaction.parentUser : interaction.user;

  if (interaction.origin != "sistema") {
    query[`${interaction.origin}Id`] = userId;
  } else {
    query = { _id: userId };
  }

  const UserModel = mongoose.model("User");
  const user = await UserModel.findOne(query).exec();

  if (user) user.network = interaction.origin;

  return user;
};

export const findBy = async args => {
  const UserModel = mongoose.model("User");
  const result = await UserModel.findOne(args).exec();
  return result || _throw("Error finding user");
};

const findAll = async (
  isCoreTeam = false,
  limit = 20,
  selectOptions = "-email -teams -_id -lastUpdate",
  team = null
) => {
  const UserModel = mongoose.model("User");
  const base_query = {
    score: { $gt: 0 },
    isCoreTeam: isCoreTeam
  };

  let query = {
    ...base_query
  };

  if (team) {
    query = {
      ...base_query,
      teams: team
    };
  }

  const result = await UserModel.find(query)
    .sort({
      score: -1
    })
    .limit(limit)
    .select(selectOptions)
    .exec();
  result.map(user => {
    user.score = parseInt(user.score);
  });

  return result || _throw("Error finding all users");
};

const rankingPosition = async (userId, isCoreTeam = false) => {
  let position;
  const allUsers = await findAll(isCoreTeam, 0);
  const user = await getNetwork(userId);
  if (user.network === "rocket") {
    position = (await allUsers.map(e => e.rocketId).indexOf(user.rocketId)) + 1;
  } else {
    position = (await allUsers.map(e => e.rocketId).indexOf(user.slackId)) + 1;
  }
  return position;
};

const checkCoreTeam = async () => {
  const UserModel = mongoose.model("User");
  const UsersBulk = UserModel.bulkWrite([
    {
      updateMany: {
        filter: { isCoreTeam: undefined },
        update: { isCoreTeam: false },
        upsert: { upsert: false }
      }
    },
    {
      updateMany: {
        filter: { slackId: { $in: config.coreteam.members } },
        update: { isCoreTeam: true },
        upsert: { upsert: false }
      }
    }
  ]);

  return UsersBulk;
};

const findInactivities = async () => {
  const UserModel = mongoose.model("User");
  const today = new Date();
  const dateRange = today.setDate(
    today.getDate() - config.xprules.inactive.mindays
  );
  const result = await UserModel.find({
    lastUpdate: { $lt: dateRange }
  })
    .sort({
      score: -1
    })
    .exec();

  return result || _throw("Error finding inactivity users");
};

const createUserData = async (userInfo, score, interaction, UserModel) => {
  let obj = {};
  const level = 1;

  if (userInfo) {
    obj = {
      avatar: userInfo.profile.image_72,
      name: userInfo.profile.real_name,
      email: userInfo.profile.email,
      level: level,
      score: score,
      slackId: interaction && interaction.user,
      messages: interaction && interaction.type === "message" ? 1 : 0,
      replies: interaction && interaction.type === "thread" ? 1 : 0,
      reactions: calculateReactions(interaction, 0) || 0,
      lastUpdate: new Date(),
      isCoreTeam: false
    };
  } else {
    obj = {
      name: interaction.username,
      level: level,
      score: score,
      rocketId: interaction && interaction.user,
      messages: interaction && interaction.type === "message" ? 1 : 0,
      replies: interaction && interaction.type === "thread" ? 1 : 0,
      reactions: calculateReactions(interaction, 0) || 0,
      lastUpdate: new Date(),
      isCoreTeam: false
    };
  }

  const instance = new UserModel(obj);
  return await instance.save();
};

const updateUserData = async (user, interaction, score) => {
  if (!user) _throw("Error updating user");

  const newScore = user.score + score;
  user.level = calculateLevel(newScore);
  user.score = newScore < 0 ? 0 : newScore;
  user.isCoreTeam = false;
  if (interaction) {
    user.messages =
      interaction.type === "message" ? user.messages + 1 : user.messages;
    user.replies =
      interaction.type === "thread" ? user.replies + 1 : user.replies;
    user.reactions = calculateReactions(interaction, user.reactions);
  }
  return await user.save();
};

const getNetwork = async user_id => {
  let user = {};
  const UserModel = mongoose.model("User");
  const slack_user = await UserModel.findOne({ slackId: user_id });
  const rocket_user = await UserModel.findOne({ rocketId: user_id });
  if (slack_user) {
    user = slack_user;
    user.network = "slack";
  } else if (rocket_user) {
    user = rocket_user;
    user.network = "rocket";
  }

  return user;
};

const updateScore = async (user, score) => {
  if (user) {
    const newScore = user.score + score;
    user.level = calculateLevel(newScore);
    user.score = newScore;
    return await user.save();
  }

  return;
};

const changeTeams = async (userId, teams) => {
  const UserModel = mongoose.model("User");
  const user = await getNetwork(userId);

  let result = {};
  try {
    result = await UserModel.findByIdAndUpdate(
      user._id,
      {
        teams: teams.split(",") || ""
      },
      (err, doc) => {
        if (err) return false;
        console.log(doc);

        return doc;
      }
    );
  } catch (e) {
    return false;
  }

  return result;
};

const rocketInfo = async user_id => {
  const url = `${process.env.ROCKET_HOST}/api/v1/users.info`;

  return axios.get(url, {
    params: {
      userId: user_id
    },
    headers: {
      "X-Auth-Token": process.env.ROCKET_USER_TOKEN,
      "X-User-Id": process.env.ROCKET_USER_ID
    }
  });
};

const fromRocket = async usersAtena => {
  let users = [];
  for (let user of usersAtena) {
    let name;
    let network;
    if (user.rocketId) {
      let response = await rocketInfo(user.rocketId);
      name = response.data.user.name;
      network = "rocket";
    } else {
      name = user.name;
      network = "slack";
    }
    users.push({
      name: name,
      user_id: user.rocketId,
      network: network
    });
  }
  return users;
};

const details = async (req, res) => {
  const { team, token } = req.headers;
  const { id } = req.params;
  let query = { rocketId: id };
  if (isValidToken(team, token)) {
    query = {
      ...query,
      teams: team
    };
  }
  const user = await findBy(query);
  const interactions = await interactionController.findBy({ user: id });
  const response = {
    user,
    avatar: `${process.env.ROCKET_HOST}/api/v1/users.getAvatar?userId=${
      user.rocketId
    }`,
    interactions: interactions
  };
  res.json(response);
};

export const save = async obj => {
  const user = userModel(obj);
  return await user.save();
};

export const commandScore = async message => {
  let user = {};
  let myPosition = 0;
  let response = {
    msg: "Ops! Você ainda não tem pontos registrados."
  };
  user = await findBy({ username: message.u.username });
  myPosition = await rankingPosition(user.rocketId);

  response = {
    msg: `Olá ${user.name}, atualmente você está no nível ${user.level} com ${
      user.score
    } XP`,
    attachments: [
      {
        text: `Ah, e você está na posição ${myPosition} do ranking`
      }
    ]
  };

  await driver.sendDirectToUser(response, message.u.username);
};

export const handleFromNext = async data => {
  try {
    let user = await userModel
      .findOne({ rocketId: data.rocket_chat.id })
      .exec();

    if (!user) {
      const userData = {
        rocketId: data.rocket_chat.id,
        name: data.fullname,
        username: data.rocket_chat.username,
        uuid: data.uuid
      };

      user = await save(userData);
    }

    user.rocketId = data.rocket_chat.id;
    user.name = data.fullname;
    user.email = data.network_email;
    user.linkedinId = data.linkedin.uid;
    user.username = data.rocket_chat.username;
    user.uuid = data.uuid;
    user.pro = await isEligibleToPro(user, data);
    if (user.pro && data.current_plan.begin_at && data.current_plan.finish_at) {
      user.proBeginAt = data.current_plan.begin_at;
      user.proFinishAt = data.current_plan.finish_at;
    }
    return await user.save();
  } catch (err) {
    console.error(err);
  }
};

export const valid = async data => {
  return api
    .getUserInfo(data.u._id)
    .then(res => {
      if (!res) {
        return Promise.reject("usuário não encontrado na api do rocket");
      }

      return findAndUpdate(res);
    })
    .then(res => {
      return res;
    })
    .catch(() => {
      return Promise.reject("usuário não encontrado na api do rocket");
    });
};

const findAndUpdate = res => {
  return userModel
    .findOneAndUpdate(
      {
        rocketId: res._id
      },
      {
        $set: {
          name: res.name,
          rocketId: res._id,
          username: res.username
        },
        $setOnInsert: {
          level: 1
        }
      },
      { upsert: true, setDefaultsOnInsert: true },
      (err, doc) => {
        return doc;
      }
    )
    .exec();
};

export const calculateLevel = score => {
  const level = config.levelrules.levels_range.findIndex(l => score < l) + 1;
  return level;
};

export const handlePro = async user => {
  const isEligiblePro = await isEligibleToPro(user);
  if (isEligiblePro != user.pro) {
    runPublisher(user);
  }

  return isEligiblePro;
};

const isCoreTeam = async obj => {
  return userModel
    .findOne(obj)
    .then((doc, err) => {
      if (err) {
        return false;
      }
      return doc.isCoreTeam;
    })
    .catch(() => {
      return false;
    });
};

const sendPro = async (username, response, req, res) => {
  response.text = response.msg;
  if (res) {
    res.json(response);
  } else {
    driver.sendDirectToUser(response, username);
  }
};

const isPro = async (req, res) => {
  let response = {
    msg: "Ops! Você não tem plano pro"
  };
  let username;
  if (res) {
    username = req.body.username;
  } else {
    username = req.u.username;
  }
  defaultFunctions
    .findBy({ username: username, pro: true })
    .then(user => {
      response = {
        msg: `Olá ${user.name}, você tem um plano pro`,
        attachments: [
          {
            text: `Início do Plano: ${moment(user.proBeginAt).format(
              "DD/MM/YYYY"
            ) || "Sem data definida"}`
          },
          {
            text: `Fim do Plano: ${moment(user.proFinishAt).format(
              "DD/MM/YYYY"
            ) || "Sem data definida"}`
          }
        ]
      };
    })
    .catch(() => {
      return Promise.resolve();
    })
    .then(() => {
      sendPro(username, response, req, res);
    });
};

export const defaultFunctions = {
  calculateLevel,
  find,
  findAll,
  update,
  updateParentUser,
  rankingPosition,
  checkCoreTeam,
  findInactivities,
  findBy,
  findByOrigin,
  getNetwork,
  updateScore,
  changeTeams,
  fromRocket,
  details,
  save,
  commandScore,
  handleFromNext,
  valid,
  customUpdate,
  handlePro,
  isCoreTeam,
  isPro,
  sendPro
};

export default defaultFunctions;

import { Context, Schema, h } from 'koishi'

import '@koishijs/plugin-proxy-agent'

export const name = 'sc2arcade-search'

export interface Config {
  proxyAgent: string
  sensitiveword: boolean
  checkHandle: boolean
  enableOtherFunctions: boolean  // 新增：是否开启其他所有功能
  mapMonitorEnabled: boolean
  mapMonitorGroups: string[]
  mapMonitorMapIds: number[]
}

export const Config: Schema<Config> = Schema.object({
  proxyAgent: Schema.string().description('代理服务器地址'),
  sensitiveword: Schema.boolean().description('是否启用敏感词过滤功能').default(true),
  checkHandle: Schema.boolean().description('是否开启绑定句柄检测').default(true),
  enableOtherFunctions: Schema.boolean().description('是否开启房间查询、战绩、排行榜等所有其他功能').default(true),  // 新增配置项
  mapMonitorEnabled: Schema.boolean().description('是否启用地图检测定时任务').default(false),
  mapMonitorGroups: Schema.array(Schema.string()).description('地图检测广播的群组ID列表').default([]),
  mapMonitorMapIds: Schema.array(Schema.number()).description('需要检测的地图ID列表').default([]),
})

export const inject = {
  required: ['database'],
}

declare module 'koishi' {
  interface Tables {
    sc2arcade_player: player
    sc2arcade_map: map
    sc2arcade_sensitiveword: sensitiveName
    sc2arcade_map_monitor: mapMonitorState
  }
}

export interface player {
  id: number
  userId: string
  regionId: number
  realmId: number
  profileId: number
  createdAt: Date
  isActive: boolean
}

export interface map {
  guildId: string
  regionId: number
  mapId: number
  createdAt: Date
}

export interface sensitiveName {
  name: string
  isSensitive: boolean
  lastdate: Date
}

export interface mapMonitorState {
  mapId: number
  lastState: string
  lastCheckedAt: Date
}

export function apply(ctx: Context, config: Config) {
  // 辅助函数：检查其他功能是否启用
  function checkOtherFunctionsEnabled() {
    if (!config.enableOtherFunctions) {
      return '⚠️ 此功能暂未开启，请联系管理员。';
    }
    return null;
  }

  ctx.model.extend('sc2arcade_player', {
    id: 'unsigned',
    userId: 'string',
    regionId: 'unsigned',
    realmId: 'unsigned',
    profileId: 'unsigned',
    createdAt: 'timestamp',
    isActive: 'boolean',
  }, {
    autoInc: true,
    primary: 'id'
  })

  ctx.model.extend('sc2arcade_map', {
    guildId: 'string',
    regionId: 'unsigned',
    mapId: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'guildId'
  })

  ctx.model.extend('sc2arcade_sensitiveword', {
    name: 'string',
    isSensitive: 'boolean',
    lastdate: 'timestamp',
  }, {
    primary: 'name'
  })

  ctx.model.extend('sc2arcade_map_monitor', {
    mapId: 'unsigned',
    lastState: 'text',
    lastCheckedAt: 'timestamp',
  }, {
    primary: 'mapId'
  })

  // 地图检测定时任务
  if (config.mapMonitorEnabled && config.mapMonitorGroups.length > 0 && config.mapMonitorMapIds.length > 0) {
    ctx.setInterval(async () => {
      try {
        const response = await ctx.http.get('https://server.dreamprotocol.info:13085/mapmonitor/maps');
        const maps: any[] = response.maps || [];

        for (const mapId of config.mapMonitorMapIds) {
          const mapData = maps.find((m: any) => m.mapId === mapId);
          if (!mapData) continue;

          const currentState = JSON.stringify(mapData);
          const [previousRecord] = await ctx.database.get('sc2arcade_map_monitor', { mapId });

          if (!previousRecord) {
            // 首次运行，仅存储状态不广播
            await ctx.database.create('sc2arcade_map_monitor', {
              mapId,
              lastState: currentState,
              lastCheckedAt: new Date(),
            });
            continue;
          }

          if (previousRecord.lastState !== currentState) {
            // 状态变化，广播通知
            const message = formatMapMonitorMessage(mapData, previousRecord);

            const bot = ctx.bots[0];
            if (bot) {
              for (const groupId of config.mapMonitorGroups) {
                try {
                  await bot.sendMessage(groupId, message);
                } catch (e) {
                  console.error(`发送地图检测消息到群组 ${groupId} 失败:`, e);
                }
              }
            }

            await ctx.database.set('sc2arcade_map_monitor', { mapId }, {
              lastState: currentState,
              lastCheckedAt: new Date(),
            });
          }
        }
      } catch (error) {
        console.error('地图检测任务执行失败:', error);
      }
    }, 60000);
  }

  function getRegionName(regionId: number): string {
    const regionMap = {
      1: '[US]',
      2: '[EU]',
      3: '[KR]',
      5: '[CN]'
    }
    return regionMap[regionId] || `[${regionId}]`
  }

  function formatHandle(handle: player, isActive = false): string {
    const region = getRegionName(handle.regionId)
    const activeMark = isActive ? ' (当前使用)' : ''
    return `${region} ${handle.regionId}-S2-${handle.realmId}-${handle.profileId}${activeMark}`
  }

  // 房间查询 - 受 enableOtherFunctions 控制
  ctx.guild()
    .command('sc2arcade/房间', '查询正在等待的房间')
    .action(async (argv) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords;
        const { regionId, mapId } = mapRecord;
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/history?regionId=${regionId}&mapId=${mapId}&orderDirection=desc&includeSlots=true`,
          config.proxyAgent
        );

        return await lobbiesHistory(ctx, config, response, 'open');
      } catch (error) {
        console.error('查询房间命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 历史房间 - 受 enableOtherFunctions 控制
  ctx.guild()
    .command('sc2arcade/历史房间', '查询已经开始的房间')
    .action(async (argv) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords;
        const { regionId, mapId } = mapRecord;
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/history?regionId=${regionId}&mapId=${mapId}&orderDirection=desc&includeSlots=true`,
          config.proxyAgent
        );

        return await lobbiesHistory(ctx, config, response, 'started');
      } catch (error) {
        console.error('查询历史房间命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 场数排行 - 受 enableOtherFunctions 控制
  ctx.guild()
    .command('sc2arcade/场数排行', '查询游玩地图的场数排行榜')
    .alias('场次排行')
    .action(async (argv) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords;
        const { regionId, mapId } = mapRecord;
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/maps/${regionId}/${mapId}/player-base?orderBy=lobbiesStarted&orderDirection=desc`,
          config.proxyAgent
        );

        return await mapsplayerbase(response);
      } catch (error) {
        console.error('查询场数排行命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 大厅 - 受 enableOtherFunctions 控制
  ctx.command('sc2arcade/大厅 [regionId]', '查询大厅中正在等待的房间')
    .action(async (argv, regionId) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      const session = argv.session;
      if (!regionId) {
        await session.send(`<quote id="${session.messageId}"/>请在30秒内输入区域ID:\n(可用的区域ID: US, EU, KR, CN)`)

        regionId = await session.prompt(30000)
        if (!regionId) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
      }
      
      const validRegionIds = ['US', 'EU', 'KR', 'CN'];
      if (!validRegionIds.includes(regionId.toUpperCase())) {
        return `<quote id="${session.messageId}"/>❌ 区域ID错误, 请重新输入。\n(可用的区域ID: US, EU, KR, CN)`;
      }

      const regionCodeMap = {
        US: { code: 1, name: '[US]' },
        EU: { code: 2, name: '[EU]' },
        KR: { code: 3, name: '[KR]' },
        CN: { code: 5, name: '[CN]' }
      };
      const regionInfo = regionCodeMap[regionId.toUpperCase()];
      const regionCode = regionInfo.code;
      const regionName = regionInfo.name;

      try {
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/active?regionId=${regionCode}&includeMapInfo=true`,
          config.proxyAgent
        );

        return `<quote id="${session.messageId}"/>` + lobbiesActive(response, regionName);
      } catch (error) {
        console.error('查询大厅信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 战绩 - 受 enableOtherFunctions 控制
  ctx.command('sc2arcade/战绩 [user]', '查询近20场的游戏战绩')
    .usage('user 参数为选填项')
    .example('/战绩, 查询自己的游戏战绩\n    /战绩 @用户, 查询其他用户的游戏战绩')
    .action(async (argv, user) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      const session = argv.session;
      try {
        if (!user) {
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: session.userId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/matches?orderDirection=desc`,
            config.proxyAgent
          );

          const history = profilesMatches(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的战绩。`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"战绩 @用户"查询其他用户的游戏战绩。`
          }
          const targetUserId = parsedUser.attrs.id;
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: targetUserId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/matches?orderDirection=desc`,
            config.proxyAgent
          );

          const history = profilesMatches(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的战绩。`;
        }
      } catch (error) {
        console.error('查询战绩失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 场数 - 受 enableOtherFunctions 控制
  ctx.command('sc2arcade/场数 [user]', '查询游玩所有地图的场数')
    .alias('场次')
    .usage('user 参数为选填项')
    .example('/场数, 查询自己游玩的所有地图的场数\n    /场数 @用户, 查询其他用户游玩的所有地图的场数')
    .action(async (argv, user) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      const session = argv.session;
      try {
        if (!user) {
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: session.userId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的场数。`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"场数 @用户"查询其他用户游玩的所有地图的累计场数排行榜。`
          }
          const targetUserId = parsedUser.attrs.id;
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: targetUserId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的场数。`;
        }
      } catch (error) {
        console.error('查询游戏场数失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 绑定指令 - 始终可用
  ctx.command('sc2arcade/绑定 [handle]', '绑定星际争霸2游戏句柄')
    .alias('绑定句柄')
    .usage('游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID]')
    .action(async (argv, handle) => {
      const session = argv.session;
      if (!handle) {
        await session.send(`<quote id="${session.messageId}"/>请在30秒内输入游戏句柄:\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])\n例如：5-S2-1-1234567`)
        handle = await session.prompt(30000)
        if (!handle) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
      }

      const handleRegex = /^([1235])-s2-([12])-(\d+)$/i;
      if (!handleRegex.test(handle)) {
        return `<quote id="${session.messageId}"/>❌ 游戏句柄格式错误, 请重新输入。\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])\n例如：5-S2-1-1234567`;
      }

      const standardizedHandle = handle.replace(/-s2-/i, '-S2-');
      const [, regionId, realmId, profileId] = standardizedHandle.match(handleRegex)!.map(Number);

      const existingHandle = await ctx.database.get('sc2arcade_player', {
        regionId,
        realmId,
        profileId
      });

      if (existingHandle.length > 0) {
        return `<quote id="${session.messageId}"/>❌ 绑定失败, 该游戏句柄已被其他用户绑定。`;
      }

      const userHandles = await ctx.database.get('sc2arcade_player', { userId: session.userId });
      const alreadyBound = userHandles.some(h =>
        h.regionId === regionId &&
        h.realmId === realmId &&
        h.profileId === profileId
      );

      if (alreadyBound) {
        return `<quote id="${session.messageId}"/>❌ 您已绑定过该游戏句柄。`;
      }

      try {
        if (config.checkHandle) {
          await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}`,
            config.proxyAgent
          );
        }

        const isFirstHandle = userHandles.length === 0;

        await ctx.database.create('sc2arcade_player', {
          userId: session.userId,
          regionId,
          realmId,
          profileId,
          isActive: isFirstHandle,
          createdAt: new Date()
        });

        const checkStatus = config.checkHandle ? '并已通过验证' : '（未验证句柄有效性）';
        return `<quote id="${session.messageId}"/>✅ 您已成功绑定游戏句柄${isFirstHandle ? '并设为当前使用' : ''}${checkStatus}。`;
      } catch (error) {
        if (config.checkHandle && error.response && error.response.status === 404) {
          return `<quote id="${session.messageId}"/>❌ 绑定失败, 您尝试绑定的游戏句柄不存在。`;
        }
        console.error('查询或绑定失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 句柄查询 - 始终可用
  ctx.command('sc2arcade/句柄 [user]', '查询已经绑定的星际争霸2游戏句柄')
    .usage('user 参数为选填项')
    .example('/句柄, 查询自己绑定的游戏句柄\n    /句柄 @用户, 查询其他用户绑定的游戏句柄')
    .action(async (argv, user) => {
      const session = argv.session;
      try {
        if (!user) {
          const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

          if (!handles || handles.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
          }

          const message = handles.map((h, index) =>
            `${index + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          return `<quote id="${session.messageId}"/>您绑定的游戏句柄：\n${message}`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"句柄 @用户"查询其他用户绑定的游戏句柄。`
          }
          const targetUserId = parsedUser.attrs.id;
          const handles = await ctx.database.get('sc2arcade_player', { userId: targetUserId });

          if (!handles || handles.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄。`;
          }

          const message = handles.map((h, index) =>
            `${index + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          return `<quote id="${session.messageId}"/>对方绑定的游戏句柄：\n${message}`;
        }
      } catch (error) {
        console.error('查询句柄信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 切换句柄 - 始终可用
  ctx.command('sc2arcade/切换 [index]', '切换正在使用的游戏句柄')
    .action(async (argv, indexParam) => {
      const session = argv.session;
      try {
        const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

        if (!handles || handles.length === 0) {
          return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
        }

        let index: number | null = null;

        if (!indexParam) {
          const message = handles.map((h, i) =>
            `${i + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          await session.send(`<quote id="${session.messageId}"/>请选择要切换的句柄：\n${message}\n\n回复序号进行切换`);

          const choice = await session.prompt(30000);
          if (!choice) return `<quote id="${session.messageId}"/>已取消操作。`;

          index = parseInt(choice);
        } else {
          index = parseInt(indexParam);
        }

        if (isNaN(index) || index < 1 || index > handles.length) {
          return `<quote id="${session.messageId}"/>❌ 序号无效，请输入1-${handles.length}之间的数字。`;
        }

        const selectedHandle = handles[index - 1];

        await Promise.all(handles.map(handle =>
          ctx.database.set('sc2arcade_player', { id: handle.id }, { isActive: handle.id === selectedHandle.id })
        ));

        return `<quote id="${session.messageId}"/>✅ 已切换到句柄：${formatHandle(selectedHandle)}`;
      } catch (error) {
        console.error('切换句柄时发生错误:', error);
        return '⚠️ 切换失败，请稍后尝试。';
      }
    });

  // 查询句柄 - 始终可用
  ctx.command('sc2arcade/查询 [handle]', '查询星际争霸2游戏句柄是否被绑定')
    .action(async (argv, handle) => {
      const session = argv.session;
      try {
        if (!handle) {
          await session.send(`<quote id="${session.messageId}"/>请在30秒内输入游戏句柄:\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])`)

          handle = await session.prompt(30000)
          if (!handle) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
        }

        const handleRegex = /^([1235])-S2-([12])-(\d+)$/;
        if (!handleRegex.test(handle)) {
          return `<quote id="${session.messageId}"/>❌ 游戏句柄格式错误, 请重新输入。\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])`;
        }

        const [, regionId, realmId, profileId] = handle.match(handleRegex)!.map(Number);

        const existingHandle = await ctx.database.get('sc2arcade_player', {
          regionId,
          realmId,
          profileId
        });
        if (existingHandle.length > 0) {
          return `<quote id="${session.messageId}"/>该游戏句柄已被 ${existingHandle[0].userId} 绑定。`;
        }
        else {
          return `<quote id="${session.messageId}"/>该游戏句柄暂未被其他用户绑定。`
        }

      } catch (error) {
        console.error('查询句柄信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 解绑 - 始终可用
  ctx.command('sc2arcade/解绑 [index]', '解除绑定星际争霸2游戏句柄')
    .alias('解绑句柄')
    .action(async (argv, indexParam) => {
      const session = argv.session;
      try {
        const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

        if (handles.length === 0) {
          return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
        }

        let index: number | null = null;

        if (!indexParam) {
          const message = handles.map((h, i) =>
            `${i + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          await session.send(`<quote id="${session.messageId}"/>请选择要解绑的句柄：\n${message}\n\n回复序号进行解绑`);

          const choice = await session.prompt(30000);
          if (!choice) return `<quote id="${session.messageId}"/>已取消操作。`;

          index = parseInt(choice);
        } else {
          index = parseInt(indexParam);
        }

        if (isNaN(index) || index < 1 || index > handles.length) {
          return `<quote id="${session.messageId}"/>❌ 序号无效，请输入1-${handles.length}之间的数字。`;
        }

        const handleToRemove = handles[index - 1];
        const wasActive = handleToRemove.isActive;

        await ctx.database.remove('sc2arcade_player', { id: handleToRemove.id });

        if (wasActive && handles.length > 1) {
          const nextHandle = handles.find(h => h.id !== handleToRemove.id);
          if (nextHandle) {
            await ctx.database.set('sc2arcade_player', { id: nextHandle.id }, { isActive: true });
            return `<quote id="${session.messageId}"/>✅ 已解绑句柄，并自动切换到：${formatHandle(nextHandle)}`;
          }
        }

        return `<quote id="${session.messageId}"/>✅ 已成功解绑句柄。`;
      } catch (error) {
        console.error('解绑失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 更新日志 - 受 enableOtherFunctions 控制
  ctx.guild()
    .command('sc2arcade/更新日志')
    .action(async (argv) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords;
        const { regionId, mapId } = mapRecord;
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/maps/${regionId}/${mapId}/details?locale=zhCN`,
          config.proxyAgent
        );

        const data = response.data

        const patchNotes = data.info.arcadeInfo.patchNoteSections

        if (!patchNotes || !patchNotes.length) {
          return '暂无更新日志。'
        }

        const sortedNotes = patchNotes.sort((a, b) => {
          const parseDate = (str: string) => {
            return new Date(str.replace('年', '-').replace('月', '-').replace('日', ''))
          }
          return parseDate(b.subtitle).getTime() - parseDate(a.subtitle).getTime()
        })

        const messages = []
        messages.push('🚀 最新更新日志: \n')

        sortedNotes.forEach(note => {
          messages.push(
            `▛ ${note.title} - ${note.subtitle} ▜`,
            ...note.items
              .filter(item => typeof item === 'string')
              .map(item => item.trim())
              .filter(item => item !== ''),
            ''
          )
        })

        if (messages[messages.length - 1] === '') {
          messages.pop()
        }

        return messages.join('\n')

      } catch (error) {
        console.error('查询更新日志发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 敏感词测试指令 - 受 enableOtherFunctions 控制
  ctx.command('sc2arcade/sensitive <text>', '检测文本是否包含敏感词', { authority: 3 })
    .action(async ({ session }, text) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${session.messageId}"/>${disabledMessage}`;
      
      if (!text) return '请输入要检测的文本内容'

      const isSensitive = await checkSensitiveWord(ctx, config, text)

      if (isSensitive) {
        return `检测结果: ❌ 包含敏感词\n文本: ${text}`
      } else {
        return `检测结果: ✅ 无敏感词\n文本: ${text}`
      }
    })

  // 解绑地图 - 受 enableOtherFunctions 控制
  ctx.guild()
    .command('sc2arcade/解绑地图', '解绑游戏大厅地图', { authority: 3 })
    .action(async (argv) => {
      const disabledMessage = checkOtherFunctionsEnabled();
      if (disabledMessage) return `<quote id="${argv.session.messageId}"/>${disabledMessage}`;
      
      const session = argv.session;

      try {
        const existingRecord = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });
        if (Object.keys(existingRecord).length < 1) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        await ctx.database.remove('sc2arcade_map', { guildId: session.guildId });
        return `<quote id="${session.messageId}"/>✅ 本群已成功解绑游戏大厅地图。`;
      } catch (error) {
        console.error('解绑失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 地图检测查询 - 受 mapMonitorEnabled 控制
  ctx.command('sc2arcade/地图检测', '查询已配置的地图详细信息')
    .action(async (argv) => {
      if (!config.mapMonitorEnabled || config.mapMonitorMapIds.length === 0) {
        return `<quote id="${argv.session.messageId}"/>⚠️ 地图检测功能未开启或未配置地图ID。`;
      }

      try {
        const response = await ctx.http.get('https://server.dreamprotocol.info:13085/mapmonitor/maps');
        const maps: any[] = response.maps || [];

        const targetMaps = maps.filter((m: any) => config.mapMonitorMapIds.includes(m.mapId));

        if (targetMaps.length === 0) {
          return `<quote id="${argv.session.messageId}"/>📭 未找到已配置的地图信息。`;
        }

        const fieldLabels: Record<string, string> = {
          mapName: '地图名称',
          isOnline: '在线状态',
          popularityRank: '热度排名',
          lastCheckTime: '最后检测时间',
          lastStatusChangeTime: '最后状态变更时间',
          firstSeenTime: '首次发现时间',
          offlineCountLast24h: '24h内离线次数',
          offlineCountLast30d: '30d内离线次数',
          recentEvents: '近期事件',
        };

        const timeFields = ['lastCheckTime', 'lastStatusChangeTime', 'firstSeenTime'];

        const messages = targetMaps.map((mapData: any) => {
          const lines: string[] = [];
          lines.push('━━━━━━━━━━━━━━━━');
          lines.push(`📋 ${mapData.mapName || '未知地图'} (ID: ${mapData.mapId})`);
          for (const key of Object.keys(mapData)) {
            if (key === 'mapId' || key === 'mapName') continue;
            const value = mapData[key];
            if (value !== null && value !== undefined && value !== '') {
              const label = fieldLabels[key] || key;
              let displayValue: string;
              if (key === 'isOnline') {
                displayValue = value ? '🟢 在线' : '🔴 离线';
              } else if (key === 'recentEvents') {
                displayValue = formatRecentEvents(value);
              } else if (timeFields.includes(key)) {
                displayValue = toBeijingTime(value);
              } else if (typeof value === 'object') {
                displayValue = JSON.stringify(value);
              } else {
                displayValue = String(value);
              }
              lines.push(`  ${label}: ${displayValue}`);
            }
          }
          return lines.join('\n');
        });

        return `<quote id="${argv.session.messageId}"/>${messages.join('\n')}`;
      } catch (error) {
        console.error('查询地图检测信息失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 地图检测调试指令 - 受 mapMonitorEnabled 控制
  ctx.command('sc2arcade/地图检测调试 [force]', '调试地图检测定时任务，查看API数据与存储状态的对比', { authority: 3 })
    .action(async (argv, force) => {
      if (!config.mapMonitorEnabled || config.mapMonitorMapIds.length === 0) {
        return `<quote id="${argv.session.messageId}"/>⚠️ 地图检测功能未开启或未配置地图ID。`;
      }

      try {
        const response = await ctx.http.get('https://server.dreamprotocol.info:13085/mapmonitor/maps');
        const maps: any[] = response.maps || [];

        const lines: string[] = [];
        lines.push('🔧 地图检测调试信息');
        lines.push(`API 数据生成时间: ${toBeijingTime(response.generatedAt)}`);
        lines.push('');

        for (const mapId of config.mapMonitorMapIds) {
          const mapData = maps.find((m: any) => m.mapId === mapId);
          lines.push(`━━━ 地图ID: ${mapId} ━━━`);

          if (!mapData) {
            lines.push('  ❌ API 中未找到此地图');
            lines.push('');
            continue;
          }

          const [previousRecord] = await ctx.database.get('sc2arcade_map_monitor', { mapId });
          const currentState = JSON.stringify(mapData);

          // 当前 API 数据
          lines.push('  📡 当前 API 数据:');
          lines.push(`    在线状态: ${mapData.isOnline ? '🟢 在线' : '🔴 离线'}`);
          lines.push(`    热度排名: ${mapData.popularityRank}`);
          lines.push(`    最后检测: ${toBeijingTime(mapData.lastCheckTime)}`);
          lines.push(`    状态变更: ${toBeijingTime(mapData.lastStatusChangeTime)}`);
          lines.push(`    24h离线: ${mapData.offlineCountLast24h} 次`);
          lines.push(`    近期事件: ${formatRecentEvents(mapData.recentEvents)}`);

          // 存储的旧数据
          if (previousRecord) {
            const prevData = JSON.parse(previousRecord.lastState);
            lines.push('');
            lines.push('  💾 存储的旧数据:');
            lines.push(`    在线状态: ${prevData.isOnline ? '🟢 在线' : '🔴 离线'}`);
            lines.push(`    热度排名: ${prevData.popularityRank}`);
            lines.push(`    最后检测: ${toBeijingTime(prevData.lastCheckTime)}`);
            lines.push(`    状态变更: ${toBeijingTime(prevData.lastStatusChangeTime)}`);
            lines.push(`    24h离线: ${prevData.offlineCountLast24h} 次`);
            lines.push(`    存储时间: ${toBeijingTime(previousRecord.lastCheckedAt.toISOString())}`);

            // 差异对比
            if (previousRecord.lastState !== currentState) {
              lines.push('');
              lines.push('  ⚡ 检测到变化，将会触发广播:');
              const changedFields: string[] = [];
              for (const key of Object.keys(mapData)) {
                if (key === 'mapId' || key === 'mapName' || key === 'generatedAt') continue;
                if (JSON.stringify(prevData[key]) !== JSON.stringify(mapData[key])) {
                  const fieldLabels: Record<string, string> = {
                    isOnline: '在线状态', popularityRank: '热度排名',
                    lastCheckTime: '最后检测', lastStatusChangeTime: '状态变更',
                    offlineCountLast24h: '24h离线', offlineCountLast30d: '30d离线',
                    recentEvents: '近期事件', firstSeenTime: '首次发现',
                  };
                  changedFields.push(fieldLabels[key] || key);
                }
              }
              lines.push(`    变化字段: ${changedFields.join(', ')}`);
            } else {
              lines.push('');
              lines.push('  ✅ 无变化，不会触发广播');
            }
          } else {
            lines.push('');
            lines.push('  💾 存储的旧数据: 无（首次运行会先存储不广播）');
          }

          // 强制广播
          if (force && force.toLowerCase() === 'force') {
            if (config.mapMonitorGroups.length > 0) {
              const message = formatMapMonitorMessage(mapData, previousRecord || { lastState: '{}' });
              const bot = ctx.bots[0];
              if (bot) {
                for (const groupId of config.mapMonitorGroups) {
                  try {
                    await bot.sendMessage(groupId, message);
                    lines.push(`  📤 已强制广播到群组: ${groupId}`);
                  } catch (e) {
                    lines.push(`  ❌ 广播到群组 ${groupId} 失败: ${e}`);
                  }
                }
              }
            } else {
              lines.push('  ⚠️ 未配置广播群组，无法发送');
            }
          }

          lines.push('');
        }

        return `<quote id="${argv.session.messageId}"/>${lines.join('\n')}`;
      } catch (error) {
        console.error('地图检测调试失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });
}

function profilesMatches(session: any, response: any) {
  const data = response.data.results;

  const decisionTranslate = (decision) => {
    const translations = {
      left: '🚶 离开',
      win: '🎉 胜利',
      loss: '😞 失败',
      tie: '🤝 平局'
    };
    return translations[decision] || decision;
  };

  const header = `<quote id="${session.messageId}"/>对局记录：\n`;
  const matchList = data.map((match, index) =>
    `${index + 1}. 地图: ${match.map.name}, 结果: ${decisionTranslate(match.decision)}`
  ).join('\n');

  return header + matchList;
}

function profilesMostPlayed(session: any, response: any) {
  const data = response.data;

  const topMaps = data
    .filter(item => item.lobbiesStarted > 0)
    .sort((a, b) => b.lobbiesStarted - a.lobbiesStarted)
    .slice(0, 10)
    .map((item, index) =>
      `${index + 1}. 地图: ${item.map.name}, 游戏场数: ${item.lobbiesStarted}`
    )
    .join('\n');

  return `<quote id="${session.messageId}"/>最常玩的地图排行：\n${topMaps}`;
}

function convertDateTimeFormat(dateString) {
  const date = new Date(dateString);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toBeijingTime(isoString: string): string {
  const date = new Date(isoString);
  const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = beijingTime.getUTCFullYear();
  const M = pad(beijingTime.getUTCMonth() + 1);
  const d = pad(beijingTime.getUTCDate());
  const h = pad(beijingTime.getUTCHours());
  const m = pad(beijingTime.getUTCMinutes());
  const s = pad(beijingTime.getUTCSeconds());
  return `${y}/${M}/${d} ${h}:${m}:${s}`;
}

function translateEventType(eventType: string): string {
  const translations: Record<string, string> = {
    cameBackOnline: '恢复在线',
    wentOffline: '离线',
  };
  return translations[eventType] || eventType;
}

function formatRecentEvents(events: any[]): string {
  if (!events || events.length === 0) return '无';
  const latest5 = events.slice(0, 5);
  return latest5.map((e: any) =>
    `${translateEventType(e.eventType)} (${toBeijingTime(e.eventTime)})`
  ).join(', ');
}

function mapsplayerbase(response) {
  const data = response.data.results;

  const topPlayers = data
    .filter(item => item.lobbiesStarted > 0)
    .sort((a, b) => b.lobbiesStarted - a.lobbiesStarted)
    .map((item, index) => `${index + 1}. 玩家: ${item.profile.name}, 游戏场数: ${item.lobbiesStarted}`)
    .join('\n');

  return topPlayers;
}

function lobbiesActive(response: any, regionName: string) {
  const data = response.data;

  if (!data.length) return `🚪 当前${regionName}游戏大厅暂无房间。`;

  const roomList = data.slice(0, 20).map((item, index) =>
    `${index + 1}. 地图: ${item.map.name}, 人数: ${item.slotsHumansTaken}/${item.slotsHumansTotal}`
  ).join('\n');

  return `${regionName}游戏大厅房间列表：\n${roomList}`;
}

async function makeHttpRequest(ctx: Context, url: string, proxyAgent?: string) {
  const config = proxyAgent ? { proxyAgent } : undefined;
  return await ctx.http('get', url, config);
}

async function checkSensitiveWord(ctx: Context, config: Config, content: string): Promise<boolean> {
  if (!config.sensitiveword) {
    return false
  }

  const [record] = await ctx.database.get('sc2arcade_sensitiveword', { name: content });

  if (record) {
    return record.isSensitive;
  }

  try {
    const response = await ctx.http.post(
      'https://uapis.cn/api/v1/text/profanitycheck',
      { text: content },
    );

    const isSensitive = response.status === "forbidden";

    await ctx.database.upsert('sc2arcade_sensitiveword', [{
      name: content,
      isSensitive,
      lastdate: new Date(),
    }]);

    return isSensitive;
  } catch (error) {
    console.error('敏感词检查失败:', error);
    return true;
  }
}

async function lobbiesHistory(ctx: Context, config: Config, response, status: string) {
  const rooms = response.data.results
    .filter(room => room.status === status && room.slotsHumansTaken > 0)
    .slice(0, status === 'started' ? 5 : 20);

  if (!rooms.length) {
    return status === 'started'
      ? '🚪 当前地图暂无历史房间。'
      : '🚪 当前地图暂无等待中的房间。';
  }

  const processSlots = async (slots) => {
    return Promise.all(slots.map(async (slot) => {
      const displayName = await checkSensitiveWord(ctx, config, slot.name)
        ? `${slot.name[0] || ''}***`
        : slot.name;
      return `  ${slot.slotNumber}. ${displayName}`;
    }));
  };

  const roomMessages = await Promise.all(rooms.map(async (room, index) => {
    const humanSlots = room.slots
      .filter(slot => slot.kind === 'human')
      .sort((a, b) => a.slotNumber - b.slotNumber);

    const slotList = await processSlots(humanSlots);
    return [
      `🚪 房间 ${index + 1}: ${room.slotsHumansTaken}/${room.slotsHumansTotal}`,
      `创建时间: ${convertDateTimeFormat(room.createdAt)}`,
      ...slotList,
    ].join('\n');
  }));

  return roomMessages.join('\n\n');
}

function formatMapMonitorMessage(currentData: any, previousRecord: any): string {
  const previousData = JSON.parse(previousRecord.lastState);

  const lines: string[] = [];
  lines.push('🔔 地图状态变更通知');

  if (currentData.mapName) {
    lines.push(`地图: ${currentData.mapName} (ID: ${currentData.mapId})`);
  } else {
    lines.push(`地图ID: ${currentData.mapId}`);
  }

  const fieldLabels: Record<string, string> = {
    isOnline: '在线状态',
    popularityRank: '热度排名',
    lastCheckTime: '最后检测时间',
    lastStatusChangeTime: '最后状态变更时间',
    offlineCountLast24h: '24h内离线次数',
    offlineCountLast30d: '30d内离线次数',
    recentEvents: '近期事件',
  };

  const timeFields = ['lastCheckTime', 'lastStatusChangeTime', 'firstSeenTime'];

  const formatValue = (key: string, raw: string): string => {
    if (key === 'isOnline') {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'boolean' ? (parsed ? '🟢 在线' : '🔴 离线') : raw;
      } catch { return raw; }
    }
    if (key === 'recentEvents') {
      try {
        const events = JSON.parse(raw);
        return formatRecentEvents(events);
      } catch { return raw; }
    }
    if (timeFields.includes(key)) {
      try {
        return toBeijingTime(JSON.parse(raw));
      } catch { return raw; }
    }
    return raw;
  };

  for (const key of Object.keys(currentData)) {
    if (key === 'mapId' || key === 'mapName' || key === 'recentEvents') continue;
    const prevValue = JSON.stringify(previousData[key]);
    const currValue = JSON.stringify(currentData[key]);
    if (prevValue !== currValue) {
      const label = fieldLabels[key] || key;
      lines.push(`${label}: ${formatValue(key, prevValue)} → ${formatValue(key, currValue)}`);
    }
  }

  return lines.join('\n');
}

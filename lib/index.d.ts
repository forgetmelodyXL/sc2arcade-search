import { Context, Schema } from 'koishi';
import '@koishijs/plugin-proxy-agent';
export declare const name = "sc2arcade-search";
export interface Config {
    proxyAgent: string;
}
export declare const Config: Schema<Config>;
export declare const inject: {
    required: string[];
};
declare module 'koishi' {
    interface Tables {
        sc2arcade_player: player;
        sc2arcade_map: map;
        sc2arcade_sensitive_names: sensitiveName;
    }
}
export interface player {
    userId: string;
    regionId: number;
    realmId: number;
    profileId: number;
    createdAt: Date;
}
export interface map {
    guildId: string;
    regionId: number;
    mapId: number;
    createdAt: Date;
}
export interface sensitiveName {
    name: string;
    isSensitive: boolean;
    lastdate: Date;
}
export declare function apply(ctx: Context, config: Config): void;

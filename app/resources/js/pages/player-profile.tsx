import { Deferred, Head, Link } from '@inertiajs/react';
import { Clock, Hammer, LogIn, Medal, Shield, Skull, Swords, Trophy } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ActivityFeed } from '@/components/activity-feed';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/hooks/use-translation';
import PublicLayout from '@/layouts/public-layout';
import { formatHours, type HoursMode, loadHoursMode, saveHoursMode } from '@/lib/hours-format';
import type { PlayerProfilePageData } from '@/types';

const SKILL_CATEGORIES: Record<string, string[]> = {
    Combat: ['Axe', 'Blunt', 'SmallBlunt', 'LongBlade', 'SmallBlade', 'Spear', 'Maintenance'],
    Firearm: ['Aiming', 'Reloading'],
    Crafting: ['Carpentry', 'Cooking', 'Farming', 'Fishing', 'Foraging', 'Trapping', 'Tailoring', 'Metalworking', 'Mechanics', 'Electrical'],
    Survivalist: ['Doctor', 'Lightfoot', 'Nimble', 'Sneak', 'Sprinting', 'Fitness', 'Strength'],
};

function SkillBar({ name, level }: { name: string; level: number }) {
    const maxLevel = 10;
    const pct = Math.min((level / maxLevel) * 100, 100);

    return (
        <div className="flex items-center gap-3">
            <span className="w-24 truncate text-xs text-muted-foreground">{name}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <motion.div
                    className="h-full rounded-full bg-primary"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                />
            </div>
            <span className="w-6 text-right text-xs font-medium tabular-nums">{level}</span>
        </div>
    );
}

export default function PlayerProfile({ player, recent_events, is_admin, day_length_minutes }: PlayerProfilePageData) {
    const { t } = useTranslation();
    const [hoursMode, setHoursMode] = useState<HoursMode>('ingame');

    useEffect(() => {
        setHoursMode(loadHoursMode());
    }, []);

    const changeHoursMode = (mode: HoursMode) => {
        setHoursMode(mode);
        saveHoursMode(mode);
    };

    const skills = player.skills ?? {};
    const categorizedSkills: { category: string; skills: { name: string; level: number }[] }[] = [];
    const assignedSkills = new Set<string>();

    for (const [category, skillNames] of Object.entries(SKILL_CATEGORIES)) {
        const categorySkills = skillNames
            .filter((name) => name in skills)
            .map((name) => {
                assignedSkills.add(name);
                return { name, level: skills[name] };
            });
        if (categorySkills.length > 0) {
            categorizedSkills.push({ category, skills: categorySkills });
        }
    }

    // Any uncategorized skills
    const otherSkills = Object.entries(skills)
        .filter(([name]) => !assignedSkills.has(name))
        .map(([name, level]) => ({ name, level }));
    if (otherSkills.length > 0) {
        categorizedSkills.push({ category: 'Other', skills: otherSkills });
    }

    return (
        <>
            <Head title={`${player.username} — Player Profile`} />
            <PublicLayout>
                <main className="mx-auto max-w-7xl px-4 py-8">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <Link
                            href="/rankings"
                            className="text-sm text-muted-foreground hover:text-foreground"
                        >
                            &larr; Back to Rankings
                        </Link>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{t('rankings.time_unit_label')}</span>
                            <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
                                <button
                                    type="button"
                                    onClick={() => changeHoursMode('ingame')}
                                    className={`px-3 py-1.5 transition-colors ${
                                        hoursMode === 'ingame'
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                    title={t('rankings.hours_ingame_tooltip')}
                                >
                                    {t('rankings.hours_ingame_short')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => changeHoursMode('real')}
                                    className={`px-3 py-1.5 transition-colors ${
                                        hoursMode === 'real'
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                    title={t('rankings.hours_real_tooltip')}
                                >
                                    {t('rankings.hours_real_short')}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-col gap-6">
                        {/* Hero */}
                        <div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-4">
                                <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
                                    <Shield className="size-7 text-primary" />
                                </div>
                                <div>
                                    <h1 className="text-2xl font-bold">{player.username}</h1>
                                    <div className="flex items-center gap-2">
                                        {player.profession && (
                                            <Badge variant="secondary">{player.profession}</Badge>
                                        )}
                                        <Badge variant={player.is_dead ? 'destructive' : 'outline'}>
                                            {player.is_dead ? 'Dead' : 'Alive'}
                                        </Badge>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Stat Cards */}
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            <Card>
                                <CardContent className="flex items-center gap-3 pt-4">
                                    <div className="flex size-10 items-center justify-center rounded-lg bg-red-500/10">
                                        <Skull className="size-5 text-red-500" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted-foreground">Zombie Kills</p>
                                        <p className="text-2xl font-bold tabular-nums">{player.zombie_kills.toLocaleString()}</p>
                                        {player.ranks.kills > 0 && (
                                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <Trophy className="size-3" /> Rank #{player.ranks.kills}
                                            </p>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="flex items-center gap-3 pt-4">
                                    <div className="flex size-10 items-center justify-center rounded-lg bg-green-500/10">
                                        <Clock className="size-5 text-green-500" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted-foreground">Hours Survived</p>
                                        <p className="text-2xl font-bold tabular-nums">
                                            {formatHours(player.hours_survived, hoursMode, day_length_minutes)}
                                        </p>
                                        {player.ranks.survival > 0 && (
                                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <Trophy className="size-3" /> Rank #{player.ranks.survival}
                                            </p>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="flex items-center gap-3 pt-4">
                                    <div className="flex size-10 items-center justify-center rounded-lg bg-orange-500/10">
                                        <Medal className="size-5 text-orange-500" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted-foreground">Deaths</p>
                                        <p className="text-2xl font-bold tabular-nums">{player.event_counts.death}</p>
                                        {player.ranks.deaths > 0 && (
                                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <Trophy className="size-3" /> Rank #{player.ranks.deaths}
                                            </p>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                            <Card>
                                <CardContent className="pt-4">
                                    <p className="mb-2 text-xs text-muted-foreground">Activity</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex items-center gap-1.5 text-sm">
                                            <Swords className="size-3.5 text-orange-500" />
                                            <span className="font-medium tabular-nums">{player.event_counts.pvp_hit}</span>
                                            <span className="text-xs text-muted-foreground">PvP</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-sm">
                                            <Hammer className="size-3.5 text-blue-500" />
                                            <span className="font-medium tabular-nums">{player.event_counts.craft}</span>
                                            <span className="text-xs text-muted-foreground">Craft</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-sm">
                                            <LogIn className="size-3.5 text-green-500" />
                                            <span className="font-medium tabular-nums">{player.event_counts.connect}</span>
                                            <span className="text-xs text-muted-foreground">Joins</span>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        <div className="grid gap-6 lg:grid-cols-2">
                            {/* Skills Grid */}
                            {categorizedSkills.length > 0 && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Skills</CardTitle>
                                        <CardDescription>Player skill levels (0-10)</CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="space-y-5">
                                            {categorizedSkills.map(({ category, skills: catSkills }) => (
                                                <div key={category}>
                                                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                                        {category}
                                                    </h4>
                                                    <div className="space-y-2">
                                                        {catSkills.map((skill) => (
                                                            <SkillBar key={skill.name} name={skill.name} level={skill.level} />
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}

                            {/* Event History — admin only */}
                            {is_admin && (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Recent Events</CardTitle>
                                        <CardDescription>Last 20 events for this player</CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Deferred data="recent_events" fallback={
                                            <div className="space-y-2">
                                                {Array.from({ length: 5 }).map((_, i) => (
                                                    <div key={i} className="flex items-start gap-2.5">
                                                        <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
                                                        <div className="flex-1 space-y-1">
                                                            <Skeleton className="h-4 w-48" />
                                                            <Skeleton className="h-3 w-16" />
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        }>
                                            <ActivityFeed events={recent_events ?? []} />
                                        </Deferred>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                </main>
            </PublicLayout>
        </>
    );
}

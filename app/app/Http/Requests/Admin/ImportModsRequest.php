<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class ImportModsRequest extends FormRequest
{
    /**
     * mod_id / map_folder allow letters, digits, dot, dash, underscore, space and
     * backslash (B42 mod IDs use `\`). The separator `;`, `=`, and newlines are
     * excluded so a single entry can't corrupt the semicolon-joined INI lists.
     */
    private const NAME_PATTERN = 'regex:/^[A-Za-z0-9._\- \\\\]+$/';

    /** Map tokens may also contain commas (vanilla-style "City, State" names). */
    private const MAP_PATTERN = 'regex:/^[A-Za-z0-9._\-, \\\\]+$/';

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'mods' => ['required', 'array', 'min:1', 'max:600'],
            'mods.*.workshop_id' => ['required', 'string', 'regex:/^\d{1,20}$/'],
            'mods.*.mod_id' => ['required', 'string', 'max:255', self::NAME_PATTERN],
            'mods.*.map_folder' => ['nullable', 'string', 'max:255', self::MAP_PATTERN],
            'map' => ['sometimes', 'array', 'max:64'],
            'map.*' => ['string', 'max:255', self::MAP_PATTERN],
        ];
    }
}

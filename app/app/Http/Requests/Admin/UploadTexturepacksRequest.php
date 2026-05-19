<?php

namespace App\Http\Requests\Admin;

use Illuminate\Foundation\Http\FormRequest;

class UploadTexturepacksRequest extends FormRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'archive' => ['required', 'file', 'mimetypes:application/zip,application/x-zip,application/octet-stream', 'max:512000'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'archive.required' => 'Choose a .zip file to upload.',
            'archive.file' => 'Upload must be a single file.',
            'archive.mimetypes' => 'The upload must be a .zip archive.',
            'archive.max' => 'The archive may not be larger than 500 MB.',
        ];
    }
}

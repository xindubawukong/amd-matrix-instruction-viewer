const amdExports = (() => {
  const formats = [
    { id: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv' },
    { id: 'markdown', label: 'Markdown', extension: 'md', mime: 'text/markdown' },
    { id: 'asciidoc', label: 'AsciiDoc', extension: 'adoc', mime: 'text/plain' },
    { id: 'grid', label: 'Plain-text grid', extension: 'txt', mime: 'text/plain' },
  ];

  function transpose(rows) {
    return rows[0].map((_, col) => rows.map(row => row[col]));
  }

  function decorateCell(value, format) {
    const items = Array.isArray(value) ? value : [String(value)];
    if (format === 'csv') return items.join(' ');
    if (format === 'markdown') return items.map(item => item.replaceAll('|', '\\|')).join('<br>');
    if (format === 'asciidoc') return items.map(item => item.replaceAll('|', '\\|')).join(' +\n');
    return items.join(' ');
  }

  function render(rows, format) {
    const formatted = rows.map(row => row.map(value => decorateCell(value, format)));
    const [head, ...body] = formatted;
    if (format === 'csv') {
      return formatted.map(row => row.map(value =>
        /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join(',')).join('\r\n');
    }
    if (format === 'markdown') {
      return [head, head.map(() => '---'), ...body].map(row => '| ' + row.join(' | ') + ' |').join('\n');
    }
    if (format === 'asciidoc') {
      return ['[options="header"]', '|===', ...formatted.map(row => row.map(value => '| ' + value).join('\n')), '|==='].join('\n');
    }

    const widths = head.map((_, col) => Math.max(...formatted.map(row => row[col].length)));
    const rule = char => '+' + widths.map(width => char.repeat(width + 2)).join('+') + '+';
    const line = row => '| ' + row.map((cell, col) => cell.padEnd(widths[col])).join(' | ') + ' |';
    return [rule('-'), line(head), rule('='), ...body.flatMap(row => [line(row), rule('-')])].join('\n');
  }

  function download(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { formats, transpose, render, download };
})();

{
  // Flow: add an approval function on the edit page; the inline form creates it on save.
  await openToolEditForm('sendEmail');
  let frame = await getBIWebview();
  // The edit page opens the add form inline, not as a panel over the side panel.
  await frame.locator('#approval-function-add').click();
  await frame.getByText('New Approval Function', { exact: true }).waitFor({ timeout: 15000 });
  const rows = await frame.locator('[data-testid="approval-function-param"]').allTextContents();
  if (rows.join('|') !== 'stringto|stringsubject|stringcc') throw new Error(`unexpected mirrored parameters: ${rows}`);
  await frame.getByRole('textbox', { name: /^Function Name\*/ }).fill('sendEmailNotify');
  await frame.locator('#approval-function-add-confirm').click();
  await frame.locator('[data-testid="approval-function-attached"]').waitFor({ timeout: 20000 });
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForSources((src) => collapseWhitespace(src).includes('@ai:AgentTool { requiresApproval: sendEmailNotify }')
    && collapseWhitespace(src).includes('isolated function sendEmailNotify(string to, string subject, string cc) returns boolean'),
  'sendEmailNotify attached and generated');
  console.log('added sendEmailNotify while editing');
}
